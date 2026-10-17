-- =============================================================================
-- Этап 11. Автоматизация и уведомления.
--
--  * notification_kinds — каталог: важные виды нельзя отключить в кабинете,
--    необязательные пользователь отключает по каналам (notification_preferences).
--  * Уведомления по событиям создают триггеры в той же транзакции, что и событие;
--    уникальный ключ (получатель, dedupe_key) исключает дубли при повторной обработке.
--  * Уведомления по расписанию (напоминания, оплата, еженедельный отчёт) создаёт
--    generate_scheduled_notifications — её вызывает защищённый cron-обработчик.
--  * Внешние каналы (email, Telegram) — очередь notification_deliveries: статус
--    доставки, ограниченные повторы с паузой, текст ошибки без секретов. Сбой отправки
--    не влияет на основное действие (оно уже записано).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Каталог видов
-- ---------------------------------------------------------------------------
create table public.notification_kinds (
  code      text primary key check (code ~ '^[a-z_]{3,40}$'),
  optional  boolean not null,  -- можно ли отключить в кабинете
  important boolean not null   -- по умолчанию дублируется во внешние каналы
);
insert into public.notification_kinds (code, optional, important) values
  ('session_rescheduled', false, true), ('session_cancelled', false, true), ('session_changed', false, true),
  ('lesson_reminder', true, false), ('homework_assigned', true, false), ('homework_graded', true, false),
  ('submission_received', true, false), ('test_result', true, false), ('absence_alert', false, true),
  ('payment_due', false, true), ('payment_overdue', false, true), ('manager_alert', false, true),
  ('monitoring_alert', false, true), ('weekly_report', true, true);

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_fkey foreign key (kind) references public.notification_kinds (code) on delete restrict;

-- ---------------------------------------------------------------------------
-- 2. Настройки и каналы пользователя
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  kind       text not null references public.notification_kinds (code) on delete restrict,
  channel    text not null check (channel in ('in_app', 'email', 'telegram')),
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (profile_id, kind, channel)
);

-- Важное в кабинете отключить нельзя (внешние каналы — можно: человек сам выбирает, куда получать).
create or replace function app.check_preference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.channel = 'in_app' and not new.enabled and not (select optional from public.notification_kinds where code = new.kind) then
    raise exception 'important notifications cannot be turned off in the app' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger notification_preferences_check before insert or update on public.notification_preferences
  for each row execute function app.check_preference();

create table public.notification_channels (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  channel     text not null check (channel in ('telegram')),
  address     text not null check (length(address) between 1 and 64),
  verified_at timestamptz not null default now(),
  primary key (profile_id, channel),
  constraint notification_channels_address_key unique (channel, address)
);

-- Код привязки Telegram: хранится только SHA-256, живёт 15 минут.
create table public.telegram_link_codes (
  code_sha256 text primary key check (code_sha256 ~ '^[0-9a-f]{64}$'),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Очередь доставки во внешние каналы
-- ---------------------------------------------------------------------------
create table public.notification_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid not null references public.notifications (id) on delete cascade,
  channel             text not null check (channel in ('email', 'telegram')),
  status              text not null default 'pending' check (status in ('pending', 'sending', 'retry', 'sent', 'failed', 'skipped')),
  attempts            int not null default 0 check (attempts between 0 and 10),
  max_attempts        int not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at     timestamptz not null default now(),
  locked_at           timestamptz,
  last_error          text check (length(last_error) <= 300),
  provider_message_id text check (length(provider_message_id) <= 200),
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  -- Одно уведомление — одна доставка в канал (повторная обработка не дублирует).
  constraint notification_deliveries_once_key unique (notification_id, channel),
  constraint notification_deliveries_sent_check check ((status = 'sent') = (sent_at is not null))
);
create index notification_deliveries_queue_idx on public.notification_deliveries (next_attempt_at) where status in ('pending', 'retry', 'sending');

-- Нужен ли канал получателю: явная настройка или значение по умолчанию (важное — да).
create or replace function app.wants(p_profile uuid, p_kind text, p_channel text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select enabled from public.notification_preferences where profile_id = p_profile and kind = p_kind and channel = p_channel),
    case when p_channel = 'in_app' then true else (select important from public.notification_kinds where code = p_kind) end
  );
$$;

-- После уведомления в кабинете — доставки во внешние каналы, которые человек хочет и которые у него есть.
create or replace function app.enqueue_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.wants(new.recipient_id, new.kind, 'email') and exists (select 1 from auth.users u where u.id = new.recipient_id and u.email is not null) then
    insert into public.notification_deliveries (notification_id, channel) values (new.id, 'email') on conflict do nothing;
  end if;
  if app.wants(new.recipient_id, new.kind, 'telegram') and exists (select 1 from public.notification_channels c where c.profile_id = new.recipient_id and c.channel = 'telegram') then
    insert into public.notification_deliveries (notification_id, channel) values (new.id, 'telegram') on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger notifications_enqueue after insert on public.notifications for each row execute function app.enqueue_deliveries();

-- Единая точка создания уведомления: учитывает отключённые необязательные виды, не дублирует.
create or replace function app.notify(p_org uuid, p_recipient uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recipient is null or not app.wants(p_recipient, p_kind, 'in_app') then
    return;
  end if;
  insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key)
  values (p_org, p_recipient, p_kind, p_payload, left(p_dedupe, 200))
  on conflict (recipient_id, dedupe_key) do nothing;
end;
$$;

-- Активные опекуны ученика в школе.
create or replace function app.guardians_of(p_org uuid, p_student uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gl.guardian_id from public.guardian_links gl
  join public.memberships m on m.organization_id = gl.organization_id and m.profile_id = gl.guardian_id and m.role = 'parent' and m.status = 'active'
  where gl.organization_id = p_org and gl.student_id = p_student and gl.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- 4. Уведомления по событиям
-- ---------------------------------------------------------------------------
-- Домашнее задание выдано → ученики группы.
create or replace function app.notify_homework_assigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student uuid;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    for v_student in select student_id from public.enrollments where group_id = new.group_id and status in ('pending', 'active') loop
      perform app.notify(new.organization_id, v_student, 'homework_assigned',
        jsonb_build_object('assignmentId', new.id, 'title', new.title, 'dueAt', new.due_at), 'homework-assigned:' || new.id || ':' || v_student);
    end loop;
  end if;
  return null;
end;
$$;
create trigger assignments_notify after insert or update of status on public.assignments for each row execute function app.notify_homework_assigned();

-- Работа сдана → преподаватели группы; проверена или возвращена → ученик.
create or replace function app.notify_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a       public.assignments%rowtype;
  v_teacher uuid;
begin
  select * into v_a from public.assignments where id = new.assignment_id;
  if tg_op = 'INSERT' then
    for v_teacher in select teacher_id from public.group_teachers where group_id = v_a.group_id loop
      perform app.notify(new.organization_id, v_teacher, 'submission_received',
        jsonb_build_object('assignmentId', v_a.id, 'title', v_a.title, 'submissionId', new.id, 'studentId', new.student_id),
        'submission:' || new.id || ':' || v_teacher);
    end loop;
  elsif new.status in ('graded', 'returned') and new.status is distinct from old.status then
    perform app.notify(new.organization_id, new.student_id, 'homework_graded',
      jsonb_build_object('assignmentId', v_a.id, 'title', v_a.title, 'status', new.status, 'score', new.score::text, 'maxScore', v_a.max_score::text),
      'homework-graded:' || new.id || ':' || new.status || ':' || extract(epoch from new.updated_at)::bigint);
  end if;
  return null;
end;
$$;
create trigger assignment_submissions_notify after insert or update of status on public.assignment_submissions for each row execute function app.notify_submission();

-- Результат теста → ученик и опекуны.
create or replace function app.notify_test_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_to    uuid;
begin
  select title into v_title from public.assessments where id = new.assessment_id;
  for v_to in select new.student_id union select app.guardians_of(new.organization_id, new.student_id) loop
    perform app.notify(new.organization_id, v_to, 'test_result',
      jsonb_build_object('attemptId', new.id, 'title', v_title, 'score', new.score::text, 'maxScore', new.max_score::text, 'studentId', new.student_id),
      'test-result:' || new.id || ':' || v_to);
  end loop;
  return null;
end;
$$;
create trigger assessment_attempts_notify after insert on public.assessment_attempts for each row execute function app.notify_test_result();

-- Пропуск → ученик и опекуны; второй пропуск подряд в группе → руководство филиала.
create or replace function app.notify_absence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s      public.lesson_sessions%rowtype;
  v_group  text;
  v_to     uuid;
  v_prev   text;
begin
  if new.status <> 'absent' or (tg_op = 'UPDATE' and old.status = 'absent') then
    return null;
  end if;
  select * into v_s from public.lesson_sessions where id = new.session_id;
  select name into v_group from public.groups where id = v_s.group_id;
  for v_to in select new.student_id union select app.guardians_of(new.organization_id, new.student_id) loop
    perform app.notify(new.organization_id, v_to, 'absence_alert',
      jsonb_build_object('sessionId', v_s.id, 'groupName', v_group, 'start', lower(v_s.period), 'studentId', new.student_id),
      'absence:' || new.id || ':' || v_to);
  end loop;
  -- Предыдущее занятие этой группы с отметкой ученика.
  select r.status into v_prev from public.attendance_records r join public.lesson_sessions s on s.id = r.session_id
   where s.group_id = v_s.group_id and r.student_id = new.student_id and lower(s.period) < lower(v_s.period)
   order by lower(s.period) desc limit 1;
  if v_prev = 'absent' then
    for v_to in
      select distinct m.profile_id from public.memberships m
       where m.organization_id = new.organization_id and m.status = 'active' and m.role in ('branch_manager', 'admin', 'org_director')
         and (m.branch_id is null or m.branch_id = new.branch_id)
    loop
      perform app.notify(new.organization_id, v_to, 'manager_alert',
        jsonb_build_object('reason', 'absence_streak', 'studentId', new.student_id, 'groupName', v_group, 'sessionId', v_s.id),
        'absence-streak:' || new.student_id || ':' || v_s.id || ':' || v_to);
    end loop;
  end if;
  return null;
end;
$$;
create trigger attendance_records_notify after insert or update of status on public.attendance_records for each row execute function app.notify_absence();

-- ---------------------------------------------------------------------------
-- 5. Уведомления по расписанию (вызывает cron-обработчик; повторный запуск не дублирует)
-- ---------------------------------------------------------------------------
create or replace function public.generate_scheduled_notifications(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       record;
  v_to      uuid;
  v_before  bigint;
  v_lessons int := 0;
  v_due     int := 0;
  v_overdue int := 0;
  v_reports int := 0;
  v_tz      text;
  v_week    text;
begin
  select count(*) into v_before from public.notifications;
  -- Напоминание о занятии: начинается в ближайшие 24 часа → ученики и преподаватель.
  for v_r in
    select s.*, g.name as group_name, b.timezone from public.lesson_sessions s
      join public.groups g on g.id = s.group_id join public.branches b on b.id = s.branch_id
     where s.status = 'scheduled' and lower(s.period) > p_now and lower(s.period) <= p_now + interval '24 hours'
  loop
    for v_to in select student_id from public.enrollments where group_id = v_r.group_id and status = 'active' union select v_r.teacher_id loop
      perform app.notify(v_r.organization_id, v_to, 'lesson_reminder',
        jsonb_build_object('sessionId', v_r.id, 'groupName', v_r.group_name, 'start', lower(v_r.period), 'timezone', v_r.timezone, 'onlineUrl', v_r.online_url),
        'lesson-reminder:' || v_r.id || ':' || v_to);
    end loop;
  end loop;
  select count(*) - v_before into v_lessons from public.notifications;

  -- Срок оплаты через 3 дня и просрочка (раз в неделю) → плательщик и опекуны.
  for v_r in
    select i.*, o.default_timezone as tz, app.invoice_due(i.id) - app.invoice_paid(i.id) as outstanding
      from public.invoices i join public.organizations o on o.id = i.organization_id
     where i.status = 'issued' and i.due_on is not null and app.invoice_due(i.id) - app.invoice_paid(i.id) > 0
  loop
    if v_r.due_on = (p_now at time zone v_r.tz)::date + 3 then
      for v_to in select v_r.payer_id union select app.guardians_of(v_r.organization_id, v_r.payer_id) loop
        perform app.notify(v_r.organization_id, v_to, 'payment_due',
          jsonb_build_object('invoiceId', v_r.id, 'number', v_r.number, 'dueOn', v_r.due_on, 'outstanding', v_r.outstanding::numeric(14, 2)::text, 'currency', v_r.currency),
          'payment-due:' || v_r.id || ':' || v_to);
        v_due := v_due + 1;
      end loop;
    elsif v_r.due_on < (p_now at time zone v_r.tz)::date then
      v_week := to_char(p_now at time zone v_r.tz, 'IYYY-IW');
      for v_to in select v_r.payer_id union select app.guardians_of(v_r.organization_id, v_r.payer_id) loop
        perform app.notify(v_r.organization_id, v_to, 'payment_overdue',
          jsonb_build_object('invoiceId', v_r.id, 'number', v_r.number, 'dueOn', v_r.due_on, 'outstanding', v_r.outstanding::numeric(14, 2)::text, 'currency', v_r.currency),
          'payment-overdue:' || v_r.id || ':' || v_to || ':' || v_week);
        v_overdue := v_overdue + 1;
      end loop;
    end if;
  end loop;

  -- Еженедельный отчёт директору: по понедельникам (пояс школы), за прошедшие 7 дней.
  for v_r in select o.id, o.default_timezone from public.organizations o where o.status = 'active' loop
    v_tz := v_r.default_timezone;
    if extract(isodow from p_now at time zone v_tz) = 1 then
      v_week := to_char(p_now at time zone v_tz, 'IYYY-IW');
      for v_to in select m.profile_id from public.memberships m where m.organization_id = v_r.id and m.role = 'org_director' and m.status = 'active' loop
        perform app.notify(v_r.id, v_to, 'weekly_report', jsonb_build_object(
          'week', v_week,
          'newContacts', (select count(*) from public.crm_contacts where organization_id = v_r.id and created_at >= p_now - interval '7 days'),
          'newEnrollments', (select count(*) from public.enrollments where organization_id = v_r.id and created_at >= p_now - interval '7 days'),
          'received', (select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0)::numeric(14, 2)::text
                         from public.payments where organization_id = v_r.id and received_at >= p_now - interval '7 days'),
          'attendanceMarked', (select count(*) from public.attendance_records where organization_id = v_r.id and marked_at >= p_now - interval '7 days'),
          'attendancePresent', (select count(*) from public.attendance_records where organization_id = v_r.id and marked_at >= p_now - interval '7 days'
                                  and status in ('present', 'late', 'left_early')),
          'failedDeliveries', (select count(*) from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
                                where n.organization_id = v_r.id and d.status = 'failed' and d.created_at >= p_now - interval '7 days')),
          'weekly-report:' || v_r.id || ':' || v_week || ':' || v_to);
        v_reports := v_reports + 1;
      end loop;
    end if;
  end loop;
  return jsonb_build_object('lessonReminders', v_lessons, 'paymentDue', v_due, 'paymentOverdue', v_overdue, 'weeklyReports', v_reports,
                            'created', (select count(*) from public.notifications) - v_before);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Обработчик очереди (service role)
-- ---------------------------------------------------------------------------
-- Захват пачки: ожидающие и повторы, у которых подошло время, + зависшие «отправляется» дольше 10 минут.
create or replace function public.claim_deliveries(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  with picked as (
    select d.id from public.notification_deliveries d
     where (d.status in ('pending', 'retry') and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.locked_at < now() - interval '10 minutes')
     order by d.next_attempt_at
     limit least(greatest(p_limit, 1), 200)
     for update skip locked
  ), claimed as (
    update public.notification_deliveries d set status = 'sending', attempts = d.attempts + 1, locked_at = now()
      from picked where d.id = picked.id
    returning d.id, d.channel, d.attempts, d.notification_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'channel', c.channel, 'attempts', c.attempts, 'kind', n.kind, 'payload', n.payload, 'createdAt', n.created_at,
    'locale', p.locale, 'name', nullif(p.full_name, ''),
    'address', case c.channel
                 when 'email' then (select u.email from auth.users u where u.id = n.recipient_id)
                 else (select ch.address from public.notification_channels ch where ch.profile_id = n.recipient_id and ch.channel = c.channel) end)), '[]'::jsonb)
    into v_result
    from claimed c
    join public.notifications n on n.id = c.notification_id
    join public.profiles p on p.id = n.recipient_id;
  return v_result;
end;
$$;

-- Итог попытки: успех; временная ошибка → повтор с паузой 2^n минут; исчерпаны попытки → failed;
-- постоянная ошибка (нет адреса, канал не настроен) → skipped.
create or replace function public.complete_delivery(p_id uuid, p_outcome text, p_provider_id text default null, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.notification_deliveries%rowtype;
begin
  select * into v_d from public.notification_deliveries where id = p_id for update;
  if v_d.id is null or v_d.status <> 'sending' then
    raise exception 'delivery is not in progress' using errcode = '23514';
  end if;
  update public.notification_deliveries set
    status = case
      when p_outcome = 'sent' then 'sent'
      when p_outcome = 'skipped' then 'skipped'
      when v_d.attempts >= v_d.max_attempts then 'failed'
      else 'retry' end,
    sent_at = case when p_outcome = 'sent' then now() end,
    provider_message_id = left(p_provider_id, 200),
    last_error = case when p_outcome = 'sent' then null else left(p_error, 300) end,
    next_attempt_at = case when p_outcome = 'error' then now() + make_interval(mins => power(2, least(v_d.attempts, 8))::int) else v_d.next_attempt_at end,
    locked_at = null
  where id = p_id;
end;
$$;

-- Привязка Telegram: пользователь получает код, отправляет боту «/start КОД».
create or replace function public.create_telegram_link_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  delete from public.telegram_link_codes where profile_id = auth.uid() or expires_at < now();
  insert into public.telegram_link_codes (code_sha256, profile_id, expires_at)
  values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), auth.uid(), now() + interval '15 minutes');
  return v_code;
end;
$$;

create or replace function public.link_telegram(p_code text, p_chat_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
begin
  delete from public.telegram_link_codes
   where code_sha256 = encode(sha256(convert_to(upper(btrim(p_code)), 'UTF8')), 'hex') and expires_at > now()
  returning profile_id into v_profile;
  if v_profile is null then
    return false;
  end if;
  insert into public.notification_channels (profile_id, channel, address) values (v_profile, 'telegram', p_chat_id)
  on conflict (profile_id, channel) do update set address = excluded.address, verified_at = now();
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------------
alter table public.notification_kinds       enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_channels    enable row level security;
alter table public.telegram_link_codes      enable row level security;
alter table public.notification_deliveries  enable row level security;

create policy "authenticated read the kind catalog" on public.notification_kinds for select to authenticated using (true);
create policy "users read own preferences" on public.notification_preferences for select to authenticated using (profile_id = (select auth.uid()));
create policy "users set own preferences" on public.notification_preferences for insert to authenticated with check (profile_id = (select auth.uid()));
create policy "users change own preferences" on public.notification_preferences
  for update to authenticated using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));
create policy "users read own channels" on public.notification_channels for select to authenticated using (profile_id = (select auth.uid()));
create policy "users unlink own channels" on public.notification_channels for delete to authenticated using (profile_id = (select auth.uid()));
-- telegram_link_codes: без политик — только функции.
-- Проверка через definer-функцию: подзапрос к notifications под RLS видел бы только свои уведомления.
create or replace function app.can_see_delivery(p_notification uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.notifications n where n.id = p_notification
                 and (n.recipient_id = (select auth.uid()) or app.has_permission(n.organization_id, null, 'audit.read')));
$$;
create policy "recipients see delivery status; directors see failures of the school" on public.notification_deliveries
  for select to authenticated using (app.can_see_delivery(notification_id));

-- ---------------------------------------------------------------------------
-- 8. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.notification_kinds, public.notification_preferences, public.notification_channels,
  public.telegram_link_codes, public.notification_deliveries from anon, authenticated;
grant select on public.notification_kinds to authenticated;
grant select, insert on public.notification_preferences to authenticated;
grant update (enabled) on public.notification_preferences to authenticated;
grant select, delete on public.notification_channels to authenticated;
grant select on public.notification_deliveries to authenticated;
grant all on public.notification_kinds, public.notification_preferences, public.notification_channels,
  public.telegram_link_codes, public.notification_deliveries to service_role;

revoke all on function public.generate_scheduled_notifications(timestamptz), public.claim_deliveries(int),
  public.complete_delivery(uuid, text, text, text), public.create_telegram_link_code(), public.link_telegram(text, text) from public, anon;
grant execute on function public.generate_scheduled_notifications(timestamptz), public.claim_deliveries(int),
  public.complete_delivery(uuid, text, text, text), public.link_telegram(text, text) to service_role;
grant execute on function public.create_telegram_link_code() to authenticated, service_role;

grant execute on function app.can_see_delivery(uuid) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
