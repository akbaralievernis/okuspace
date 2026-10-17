-- =============================================================================
-- Блок C. Автоматизация: счета за месяц по записям и тарифам, зарплата преподавателей
-- по проведённым занятиям, отработки пропусков, замена преподавателя.
--
--  * billing_generate — черновики счетов за месяц: одна активная запись в группу —
--    один счёт по месячному тарифу курса (прайс филиала важнее прайса школы). Повтор
--    не создаёт дублей (уникально «запись + месяц», пока счёт не аннулирован).
--    billing_issue выставляет черновики месяца; счёт с неутверждённой скидкой остаётся
--    черновиком. Номер — автоматический (MYYMM-NNNN).
--  * teacher_rates — ставка за проведённое занятие (append-only: новая ставка — новая
--    строка с датой начала). payroll_generate считает ведомость по филиалам; утверждает
--    другой человек (finance.approve), выплата создаёт расход «зарплата».
--  * makeup_requests — пропуск (в т. ч. по уважительной причине) сам создаёт заявку на
--    отработку; если отметку исправили на «был», заявка закрывается. Администратор
--    назначает отработку на занятие — ученик и родители получают уведомление.
--  * Замена: в занятие можно поставить преподавателя не из группы, только с причиной.
--    Заменяющий видит это занятие, список учеников и отмечает посещаемость — только
--    в окне вокруг занятия (сутки до начала — двое суток после).
-- =============================================================================

insert into public.notification_kinds (code, optional, important) values
  ('payroll_approved', true, false), ('makeup_scheduled', false, true), ('substitution_assigned', false, true);

-- ---------------------------------------------------------------------------
-- 1. Счета за месяц
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column enrollment_id uuid references public.enrollments (id) on delete restrict,
  add column billing_month date check (extract(day from billing_month) = 1),
  add constraint invoices_billing_pair_check check ((enrollment_id is null) = (billing_month is null));
create unique index invoices_enrollment_month_key on public.invoices (enrollment_id, billing_month) where status <> 'void';

-- Номер автоматического счёта: M + ГГММ + порядковый номер в школе за этот месяц.
create or replace function app.next_invoice_number(p_org uuid, p_month date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text := 'M' || to_char(p_month, 'YYMM') || '-';
  v_n      int;
begin
  perform pg_advisory_xact_lock(hashtextextended('invoice-number:' || p_org::text, 0));
  select coalesce(max(substr(number, length(v_prefix) + 1)::int), 0) + 1 into v_n
  from public.invoices where organization_id = p_org and number ~ ('^' || v_prefix || '[0-9]{4}$');
  return v_prefix || lpad(v_n::text, 4, '0');
end;
$$;

create or replace function public.billing_generate(p_org uuid, p_month date, p_due_day int default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_end      date;
  r          record;
  v_tariff   record;
  v_invoice  uuid;
  v_created  int := 0;
  v_existing int := 0;
  v_missing  jsonb := '[]'::jsonb;
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1 or p_due_day not between 1 and 28 then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  v_end := (p_month + interval '1 month' - interval '1 day')::date;
  if not exists (select 1 from public.memberships m where m.organization_id = p_org and app.has_permission(p_org, m.branch_id, 'finance.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  for r in
    select e.id as enrollment_id, e.branch_id, e.student_id, g.course_id, g.name as group_name, c.title as course_title
    from public.enrollments e
    join public.groups g on g.id = e.group_id
    join public.courses c on c.id = g.course_id
    where e.organization_id = p_org and e.status = 'active' and g.status in ('planned', 'active')
      and (g.starts_on is null or g.starts_on <= v_end)
      and app.has_permission(p_org, e.branch_id, 'finance.write')
    order by e.branch_id, e.created_at
  loop
    if exists (select 1 from public.invoices i where i.enrollment_id = r.enrollment_id and i.billing_month = p_month and i.status <> 'void') then
      v_existing := v_existing + 1;
      continue;
    end if;
    select t.id, pl.currency into v_tariff
    from public.tariffs t join public.price_lists pl on pl.id = t.price_list_id
    where t.organization_id = p_org and t.course_id = r.course_id and t.unit = 'month' and t.status = 'active'
      and pl.status = 'active' and (pl.branch_id is null or pl.branch_id = r.branch_id)
      and pl.valid_from <= v_end and (pl.valid_to is null or pl.valid_to >= p_month)
    order by (pl.branch_id is not null) desc, pl.valid_from desc, t.created_at desc
    limit 1;
    if v_tariff.id is null then
      if jsonb_array_length(v_missing) < 100 then
        v_missing := v_missing || jsonb_build_object('enrollmentId', r.enrollment_id, 'studentId', r.student_id, 'group', r.group_name, 'course', r.course_title);
      end if;
      continue;
    end if;
    insert into public.invoices (organization_id, branch_id, payer_id, number, currency, total, status, due_on, description, created_by, enrollment_id, billing_month)
    values (p_org, r.branch_id, r.student_id, app.next_invoice_number(p_org, p_month), v_tariff.currency, 0, 'draft',
            make_date(extract(year from p_month)::int, extract(month from p_month)::int, p_due_day),
            'Обучение: ' || r.course_title || ' (' || r.group_name || '), ' || to_char(p_month, 'YYYY-MM'),
            auth.uid(), r.enrollment_id, p_month)
    returning id into v_invoice;
    insert into public.invoice_lines (organization_id, branch_id, invoice_id, tariff_id, description, quantity, unit_price)
    values (p_org, r.branch_id, v_invoice, v_tariff.id, r.course_title || ', ' || to_char(p_month, 'YYYY-MM'), 1, 0);
    v_created := v_created + 1;
  end loop;
  return jsonb_build_object('created', v_created, 'existing', v_existing, 'noTariff', v_missing);
end;
$$;

-- Выставить черновики месяца. Счёт, который выставить нельзя (неутверждённая скидка,
-- закрытый период), остаётся черновиком и попадает в список с причиной.
create or replace function public.billing_issue(p_org uuid, p_month date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_issued int := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  for v_id in
    select i.id from public.invoices i
    where i.organization_id = p_org and i.billing_month = p_month and i.status = 'draft'
      and app.has_permission(p_org, i.branch_id, 'finance.write')
    order by i.number
  loop
    begin
      update public.invoices set status = 'issued' where id = v_id;
      v_issued := v_issued + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('invoiceId', v_id, 'reason', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('issued', v_issued, 'failed', v_failed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Зарплата преподавателей
-- ---------------------------------------------------------------------------
create table public.teacher_rates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  teacher_id      uuid not null references public.profiles (id) on delete restrict,
  amount          numeric(14, 2) not null check (amount > 0),
  currency        char(3) not null default 'KGS' check (currency ~ '^[A-Z]{3}$'),
  valid_from      date not null,
  created_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  constraint teacher_rates_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete restrict
);
create index teacher_rates_lookup_idx on public.teacher_rates (organization_id, teacher_id, valid_from desc);
create trigger teacher_rates_append_only before update or delete on public.teacher_rates
  for each row execute function app.forbid_mutation();

create or replace function app.check_teacher_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.memberships m where m.organization_id = new.organization_id and m.profile_id = new.teacher_id
                   and m.role = 'teacher' and m.status = 'active' and (new.branch_id is null or m.branch_id is null or m.branch_id = new.branch_id)) then
    raise exception 'rate is only for an active teacher of this branch' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger teacher_rates_check before insert on public.teacher_rates for each row execute function app.check_teacher_rate();

create table public.payroll_statements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  teacher_id      uuid not null references public.profiles (id) on delete restrict,
  month           date not null check (extract(day from month) = 1),
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
  sessions        int not null check (sessions >= 0),
  amount          numeric(14, 2) not null check (amount >= 0),
  details         jsonb not null default '{}'::jsonb,
  status          text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  generated_by    uuid not null references public.profiles (id) on delete restrict,
  approved_by     uuid references public.profiles (id) on delete restrict,
  approved_at     timestamptz,
  paid_at         timestamptz,
  expense_id      uuid unique references public.expenses (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint payroll_statements_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete restrict,
  constraint payroll_statements_key unique (branch_id, teacher_id, month, currency),
  constraint payroll_statements_approval_check check ((status = 'draft') = (approved_by is null) and (approved_by is null) = (approved_at is null)),
  constraint payroll_statements_four_eyes_check check (approved_by is null or approved_by <> generated_by),
  constraint payroll_statements_paid_check check ((status = 'paid') = (paid_at is not null and expense_id is not null))
);
create trigger payroll_statements_set_updated_at before update on public.payroll_statements
  for each row execute function app.set_updated_at();

-- Утверждённую ведомость нельзя изменить, кроме перехода к «выплачено»; удалить нельзя.
create or replace function app.guard_payroll()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payroll statements are not deleted' using errcode = '42501';
  end if;
  if old.status <> 'draft' and (new.sessions, new.amount, new.details, new.currency, new.teacher_id, new.month)
     is distinct from (old.sessions, old.amount, old.details, old.currency, old.teacher_id, old.month) then
    raise exception 'approved payroll statement is immutable' using errcode = '42501';
  end if;
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'paid payroll statement is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger payroll_statements_guard before update or delete on public.payroll_statements
  for each row execute function app.guard_payroll();

-- Ставка на дату занятия: ставка филиала важнее ставки школы, затем — последняя по дате начала.
create or replace function app.rate_for(p_org uuid, p_branch uuid, p_teacher uuid, p_day date)
returns public.teacher_rates
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.teacher_rates r
  where r.organization_id = p_org and r.teacher_id = p_teacher and r.valid_from <= p_day and (r.branch_id is null or r.branch_id = p_branch)
  order by (r.branch_id is not null) desc, r.valid_from desc, r.created_at desc
  limit 1;
$$;

create or replace function public.payroll_generate(p_org uuid, p_month date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz      text := coalesce(app.org_timezone(p_org), 'Asia/Bishkek');
  v_from    timestamptz;
  v_to      timestamptz;
  r         record;
  v_n       int := 0;
  v_missing jsonb := '[]'::jsonb;
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  if not exists (select 1 from public.memberships m where m.organization_id = p_org and app.has_permission(p_org, m.branch_id, 'finance.write')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_from := p_month::timestamp at time zone v_tz;
  v_to := (p_month + interval '1 month')::timestamp at time zone v_tz;

  for r in
    with s as (
      select s.id, s.branch_id, s.teacher_id, s.group_id, (lower(s.period) at time zone v_tz)::date as day
      from public.lesson_sessions s
      where s.organization_id = p_org and s.status = 'done' and lower(s.period) >= v_from and lower(s.period) < v_to
        and app.has_permission(p_org, s.branch_id, 'finance.write')
    ), priced as (
      select s.*, (app.rate_for(p_org, s.branch_id, s.teacher_id, s.day)).amount as rate,
             (app.rate_for(p_org, s.branch_id, s.teacher_id, s.day)).currency as currency
      from s
    )
    select branch_id, teacher_id, currency, count(*) filter (where rate is not null) as sessions,
           coalesce(sum(rate), 0) as amount, count(*) filter (where rate is null) as unpriced,
           jsonb_object_agg_strict(group_id::text, null) as groups
    from priced group by branch_id, teacher_id, currency
  loop
    if r.currency is null then
      v_missing := v_missing || jsonb_build_object('teacherId', r.teacher_id, 'branchId', r.branch_id, 'sessions', r.unpriced);
      continue;
    end if;
    insert into public.payroll_statements (organization_id, branch_id, teacher_id, month, currency, sessions, amount, details, generated_by)
    values (p_org, r.branch_id, r.teacher_id, p_month, r.currency, r.sessions, r.amount,
            jsonb_build_object('groups', (select count(*) from jsonb_object_keys(coalesce(r.groups, '{}'::jsonb)))), auth.uid())
    on conflict (branch_id, teacher_id, month, currency) do update
      set sessions = excluded.sessions, amount = excluded.amount, details = excluded.details, generated_by = excluded.generated_by
      where public.payroll_statements.status = 'draft';
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('statements', v_n, 'noRate', v_missing);
end;
$$;

create or replace function public.payroll_approve(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.payroll_statements%rowtype;
begin
  select * into v from public.payroll_statements where id = p_id for update;
  if v.id is null or app.current_aal() <> 'aal2' or not app.has_permission(v.organization_id, v.branch_id, 'finance.approve') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.status <> 'draft' then
    raise exception 'invalid transition' using errcode = '22023';
  end if;
  if v.generated_by = auth.uid() then
    raise exception 'approver must differ from the author' using errcode = '23514';
  end if;
  update public.payroll_statements set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id;
  perform app.notify(v.organization_id, v.teacher_id, 'payroll_approved',
    jsonb_build_object('month', to_char(v.month, 'YYYY-MM'), 'amount', v.amount::text, 'currency', v.currency, 'sessions', v.sessions),
    'payroll:' || v.id);
end;
$$;

create or replace function public.payroll_pay(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v         public.payroll_statements%rowtype;
  v_expense uuid;
begin
  select * into v from public.payroll_statements where id = p_id for update;
  if v.id is null or app.current_aal() <> 'aal2' or not app.has_permission(v.organization_id, v.branch_id, 'finance.write') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.status <> 'approved' then
    raise exception 'invalid transition' using errcode = '22023';
  end if;
  if v.amount <= 0 then
    raise exception 'nothing to pay' using errcode = '23514';
  end if;
  insert into public.expenses (organization_id, branch_id, category, amount, currency, spent_on, description, created_by)
  values (v.organization_id, v.branch_id, 'salary', v.amount, v.currency,
          (now() at time zone coalesce(app.org_timezone(v.organization_id), 'Asia/Bishkek'))::date,
          'Зарплата: ' || app.display_name(v.teacher_id) || ', ' || to_char(v.month, 'YYYY-MM') || ' (' || v.sessions || ' зан.)', auth.uid())
  returning id into v_expense;
  update public.payroll_statements set status = 'paid', paid_at = now(), expense_id = v_expense where id = p_id;
  return v_expense;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Отработки пропусков
-- ---------------------------------------------------------------------------
create table public.makeup_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  branch_id         uuid not null,
  student_id        uuid not null references public.profiles (id) on delete restrict,
  missed_session_id uuid not null references public.lesson_sessions (id) on delete restrict,
  status            text not null default 'open' check (status in ('open', 'scheduled', 'done', 'cancelled')),
  makeup_session_id uuid references public.lesson_sessions (id) on delete restrict,
  note              text check (length(note) <= 500),
  handled_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint makeup_requests_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete restrict,
  constraint makeup_requests_unique_key unique (student_id, missed_session_id),
  constraint makeup_requests_session_check check ((status in ('scheduled', 'done')) = (makeup_session_id is not null) or status = 'cancelled'),
  constraint makeup_requests_other_session_check check (makeup_session_id is null or makeup_session_id <> missed_session_id)
);
create index makeup_requests_open_idx on public.makeup_requests (organization_id, branch_id, status);
create trigger makeup_requests_set_updated_at before update on public.makeup_requests
  for each row execute function app.set_updated_at();

-- Отметка «отсутствовал / уважительная» → заявка на отработку; исправили на «был» → заявка закрыта.
create or replace function app.makeup_from_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('absent', 'excused') then
    insert into public.makeup_requests (organization_id, branch_id, student_id, missed_session_id)
    values (new.organization_id, new.branch_id, new.student_id, new.session_id)
    on conflict (student_id, missed_session_id) do update set status = 'open', makeup_session_id = null
      where public.makeup_requests.status = 'cancelled' and public.makeup_requests.note is null;
  elsif tg_op = 'UPDATE' then
    update public.makeup_requests set status = 'cancelled', note = null
     where student_id = new.student_id and missed_session_id = new.session_id and status = 'open';
  end if;
  return null;
end;
$$;
create trigger attendance_records_makeup after insert or update of status on public.attendance_records
  for each row execute function app.makeup_from_attendance();

create or replace function app.can_manage_makeups(p_org uuid, p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_permission(p_org, p_branch, 'schedule.manage') or app.has_permission(p_org, p_branch, 'attendance.manage');
$$;

create or replace function public.makeup_schedule(p_request uuid, p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.makeup_requests%rowtype;
  s public.lesson_sessions%rowtype;
  v_p uuid;
begin
  select * into v from public.makeup_requests where id = p_request for update;
  if v.id is null or not app.can_manage_makeups(v.organization_id, v.branch_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.status not in ('open', 'scheduled') then
    raise exception 'invalid transition' using errcode = '22023';
  end if;
  select * into s from public.lesson_sessions where id = p_session;
  if s.id is null or s.organization_id <> v.organization_id or s.branch_id <> v.branch_id or s.status <> 'scheduled'
     or lower(s.period) <= now() or s.id = v.missed_session_id then
    raise exception 'session not available' using errcode = '22023';
  end if;
  update public.makeup_requests set status = 'scheduled', makeup_session_id = p_session, handled_by = auth.uid() where id = p_request;
  for v_p in select v.student_id union select app.guardians_of(v.organization_id, v.student_id) loop
    perform app.notify(v.organization_id, v_p, 'makeup_scheduled',
      jsonb_build_object('sessionId', s.id, 'groupName', (select name from public.groups where id = s.group_id), 'start', lower(s.period),
                         'timezone', (select timezone from public.branches where id = s.branch_id)),
      'makeup:' || v.id || ':' || s.id);
  end loop;
end;
$$;

create or replace function public.makeup_resolve(p_request uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.makeup_requests%rowtype;
begin
  select * into v from public.makeup_requests where id = p_request for update;
  if v.id is null or not app.can_manage_makeups(v.organization_id, v.branch_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status = 'done' and v.status <> 'scheduled' then
    raise exception 'invalid transition' using errcode = '22023';
  end if;
  if p_status = 'cancelled' and (v.status not in ('open', 'scheduled') or nullif(btrim(coalesce(p_note, '')), '') is null) then
    raise exception 'reason required' using errcode = '23514';
  end if;
  if p_status not in ('done', 'cancelled') then
    raise exception 'invalid transition' using errcode = '22023';
  end if;
  update public.makeup_requests set status = p_status, note = nullif(btrim(coalesce(p_note, '')), ''), handled_by = auth.uid() where id = p_request;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Замена преподавателя
-- ---------------------------------------------------------------------------
alter table public.lesson_sessions add column substitute_reason text check (length(btrim(substitute_reason)) between 1 and 300);

-- Преподаватель занятия — из группы; иначе это замена: нужна причина и активный преподаватель филиала.
create or replace function app.check_lesson_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.group_teachers where group_id = new.group_id and teacher_id = new.teacher_id) then
    new.substitute_reason := null;
    return new;
  end if;
  if new.substitute_reason is null then
    raise exception 'teacher is not assigned to this group' using errcode = '23514';
  end if;
  if not exists (select 1 from public.memberships m where m.organization_id = new.organization_id and m.profile_id = new.teacher_id
                   and m.role = 'teacher' and m.status = 'active' and (m.branch_id is null or m.branch_id = new.branch_id)) then
    raise exception 'substitute must be an active teacher of this branch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.session_substitute(p_session uuid, p_teacher uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.lesson_sessions%rowtype;
  v_is_group boolean;
begin
  select * into s from public.lesson_sessions where id = p_session for update;
  if s.id is null or not app.has_permission(s.organization_id, s.branch_id, 'schedule.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if s.status <> 'scheduled' or upper(s.period) <= now() then
    raise exception 'session not available' using errcode = '22023';
  end if;
  v_is_group := exists (select 1 from public.group_teachers where group_id = s.group_id and teacher_id = p_teacher);
  if not v_is_group and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason required' using errcode = '23514';
  end if;
  update public.lesson_sessions
     set teacher_id = p_teacher, substitute_reason = case when v_is_group then null else btrim(p_reason) end
   where id = p_session;
  if not v_is_group then
    perform app.notify(s.organization_id, p_teacher, 'substitution_assigned',
      jsonb_build_object('sessionId', s.id, 'groupName', (select name from public.groups where id = s.group_id), 'start', lower(s.period),
                         'timezone', (select timezone from public.branches where id = s.branch_id), 'note', btrim(p_reason)),
      'substitution:' || s.id || ':' || p_teacher);
  end if;
end;
$$;

-- Заменяющий в окне занятия (сутки до начала — двое суток после конца).
create or replace function app.is_substitute_now(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.lesson_sessions s
    where s.group_id = p_group and s.teacher_id = (select auth.uid()) and s.substitute_reason is not null and s.status <> 'cancelled'
      and now() between lower(s.period) - interval '1 day' and upper(s.period) + interval '48 hours'
  );
$$;

create policy "substitutes read their sessions" on public.lesson_sessions
  for select to authenticated using (teacher_id = (select auth.uid()) and substitute_reason is not null);
create policy "substitutes read the roster during the session window" on public.enrollments
  for select to authenticated using (app.is_substitute_now(group_id));
create policy "substitutes read attendance of their session" on public.attendance_records
  for select to authenticated using (exists (
    select 1 from public.lesson_sessions s where s.id = session_id and s.teacher_id = (select auth.uid()) and s.substitute_reason is not null));

-- Профили учеников видит и заменяющий — только в окне своего занятия (иначе не отметить посещаемость).
create or replace function app.can_see_profile(p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_profile = (select auth.uid())
    or app.staff_can(p_profile, 'member.read')
    or app.is_guardian_of(p_profile)
    or exists (
      select 1 from public.enrollments e
      where e.student_id = p_profile and e.status <> 'cancelled' and (app.is_group_teacher(e.group_id) or app.is_substitute_now(e.group_id))
    )
    or exists (
      select 1 from public.group_teachers gt
      where gt.teacher_id = p_profile
        and (app.is_group_student(gt.group_id) or app.is_group_guardian(gt.group_id))
    );
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS и привилегии
-- ---------------------------------------------------------------------------
alter table public.teacher_rates      enable row level security;
alter table public.payroll_statements enable row level security;
alter table public.makeup_requests    enable row level security;

create policy "finance staff and the teacher read rates" on public.teacher_rates
  for select to authenticated using (teacher_id = (select auth.uid()) or app.has_permission(organization_id, branch_id, 'finance.read'));
create policy "finance staff with mfa set rates" on public.teacher_rates
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'finance.write') and created_by = (select auth.uid()));

create policy "finance staff and the teacher read payroll" on public.payroll_statements
  for select to authenticated using (
    (teacher_id = (select auth.uid()) and status <> 'draft') or app.has_permission(organization_id, branch_id, 'finance.read'));

create policy "staff, the student and guardians read makeups" on public.makeup_requests
  for select to authenticated using (
    student_id = (select auth.uid()) or app.is_guardian_of(student_id) or app.can_manage_makeups(organization_id, branch_id)
    or exists (select 1 from public.lesson_sessions s where s.id = missed_session_id and app.is_group_teacher(s.group_id)));

revoke all on public.teacher_rates, public.payroll_statements, public.makeup_requests from anon, authenticated;
grant select, insert on public.teacher_rates to authenticated;
grant select on public.payroll_statements, public.makeup_requests to authenticated;
grant all on public.teacher_rates, public.payroll_statements, public.makeup_requests to service_role;
grant update (substitute_reason) on public.lesson_sessions to authenticated;

revoke all on function public.billing_generate(uuid, date, int), public.billing_issue(uuid, date), public.payroll_generate(uuid, date),
  public.payroll_approve(uuid), public.payroll_pay(uuid), public.makeup_schedule(uuid, uuid), public.makeup_resolve(uuid, text, text),
  public.session_substitute(uuid, uuid, text) from public, anon;
grant execute on function public.billing_generate(uuid, date, int), public.billing_issue(uuid, date), public.payroll_generate(uuid, date),
  public.payroll_approve(uuid), public.payroll_pay(uuid), public.makeup_schedule(uuid, uuid), public.makeup_resolve(uuid, text, text),
  public.session_substitute(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.is_substitute_now(uuid), app.can_manage_makeups(uuid, uuid), app.can_see_profile(uuid) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
