-- =============================================================================
-- Этап 8. CRM и продажи.
--
--  * crm_contacts — потенциальные и действующие ученики. Телефон нормализуется,
--    один телефон / email — один контакт в школе (повторная заявка не создаёт дубль).
--  * Заявки с сайта (lead_requests, этап 4) сразу попадают в CRM: новый контакт или
--    существующий, запись на пробный урок занимает место в слоте.
--  * crm_events — история общения и переходов между этапами (append-only; при удалении
--    по запросу тексты обезличиваются). Этапы и менеджер пишутся триггером — без истории
--    изменить их нельзя.
--  * Видят и меняют контакты только сотрудники с lead.read / lead.manage в своём филиале.
--    Экспорт и удаление по запросу — отдельное право crm.admin с MFA; каждый экспорт
--    записывается в журнал.
-- =============================================================================

insert into public.permissions (code, description) values
  ('crm.admin', 'Экспортировать контакты CRM и удалять их по запросу');
insert into public.role_permissions (role, permission) values
  ('org_director', 'crm.admin'), ('branch_manager', 'crm.admin');

-- ---------------------------------------------------------------------------
-- 1. Нормализация контактов
-- ---------------------------------------------------------------------------
-- Телефон → '+<цифры>'. Местный формат КР «0XXX XXX XXX» → +996XXXXXXXXX.
create or replace function app.normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d = '' then null
    when btrim(p) like '+%' then '+' || d
    when d ~ '^0[0-9]{9}$' then '+996' || substr(d, 2)
    when d ~ '^996[0-9]{9}$' then '+' || d
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;

-- Есть ли у ДРУГОГО пользователя право в филиале (для назначения менеджера).
create or replace function app.profile_has_permission(p_profile uuid, p_org uuid, p_branch uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    join public.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where m.profile_id = p_profile and m.organization_id = p_org and m.status = 'active'
      and (m.branch_id is null or m.branch_id = p_branch)
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Контакты
-- ---------------------------------------------------------------------------
create table public.crm_contacts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  branch_id        uuid,
  full_name        text not null check (length(btrim(full_name)) between 1 and 120),
  phone            text check (phone ~ '^\+?[0-9]{6,15}$'),
  email            text check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  source           text not null check (source in ('website_trial', 'website_contact', 'phone', 'walk_in', 'referral', 'social', 'import', 'other')),
  stage            text not null default 'new' check (stage in ('new', 'contacted', 'trial_booked', 'trial_done', 'offer', 'won', 'lost')),
  lost_reason      text check (length(btrim(lost_reason)) between 1 and 300),
  note             text check (length(note) <= 2000),
  owner_id         uuid references public.profiles (id) on delete set null,
  profile_id       uuid references public.profiles (id) on delete set null,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  erased_at        timestamptz,
  constraint crm_contacts_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint crm_contacts_reachable_check check (erased_at is not null or phone is not null or email is not null),
  -- «Ученик» — только после связи с учётной записью (crm_convert).
  constraint crm_contacts_won_check check (stage <> 'won' or profile_id is not null),
  constraint crm_contacts_lost_check check (stage <> 'lost' or lost_reason is not null or erased_at is not null)
);
-- Один телефон / email — один контакт школы (обезличенные не участвуют).
create unique index crm_contacts_phone_key on public.crm_contacts (organization_id, phone) where erased_at is null and phone is not null;
create unique index crm_contacts_email_key on public.crm_contacts (organization_id, email) where erased_at is null and email is not null;
create unique index crm_contacts_profile_key on public.crm_contacts (organization_id, profile_id) where profile_id is not null;
create index crm_contacts_pipeline_idx on public.crm_contacts (organization_id, branch_id, stage, last_activity_at desc);

alter table public.lead_requests add column contact_id uuid references public.crm_contacts (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. История (append-only, обезличивание — единственное допустимое изменение)
-- ---------------------------------------------------------------------------
create table public.crm_events (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  contact_id      uuid not null references public.crm_contacts (id) on delete restrict,
  kind            text not null check (kind in ('created', 'request', 'note', 'call', 'message', 'meeting', 'stage_changed', 'assigned',
                                                 'trial_booked', 'trial_result', 'converted', 'enrolled', 'imported', 'erased')),
  channel         text check (channel in ('phone', 'whatsapp', 'telegram', 'email', 'sms', 'in_person', 'other')),
  body            text check (length(body) <= 4000),
  from_stage      text,
  to_stage        text,
  actor_id        uuid, -- без FK: строка append-only
  created_at      timestamptz not null default now(),
  redacted_at     timestamptz
);
create index crm_events_contact_idx on public.crm_events (contact_id, id);

create or replace function app.guard_crm_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'append-only: crm_events cannot be deleted' using errcode = 'P0001';
  end if;
  -- Разрешено только обезличивание текста (удаление по запросу).
  if new.body is null and new.redacted_at is not null and old.redacted_at is null
     and (new.id, new.organization_id, new.contact_id, new.kind, new.channel, new.from_stage, new.to_stage, new.actor_id, new.created_at)
         is not distinct from (old.id, old.organization_id, old.contact_id, old.kind, old.channel, old.from_stage, old.to_stage, old.actor_id, old.created_at) then
    return new;
  end if;
  raise exception 'append-only: crm_events can only be redacted' using errcode = 'P0001';
end;
$$;

create trigger crm_events_guard before update or delete on public.crm_events
  for each row execute function app.guard_crm_event();
create trigger crm_events_no_truncate before truncate on public.crm_events
  for each statement execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 4. Правила контакта и автоматическая история
-- ---------------------------------------------------------------------------
create or replace function app.prepare_crm_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.erased_at is not null and current_setting('app.crm_erasing', true) is distinct from 'on' then
    raise exception 'erased contact cannot be changed' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.organization_id is distinct from old.organization_id or new.created_at is distinct from old.created_at) then
    raise exception 'contact identity is immutable' using errcode = '42501';
  end if;
  new.phone := app.normalize_phone(new.phone);
  new.email := nullif(lower(btrim(new.email)), '');
  new.full_name := btrim(new.full_name);
  -- Менеджер — только сотрудник с lead.manage в филиале контакта.
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not app.profile_has_permission(new.owner_id, new.organization_id, new.branch_id, 'lead.manage') then
    raise exception 'owner must be a sales employee of this branch' using errcode = '23514';
  end if;
  if new.stage <> 'lost' then new.lost_reason := null; end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if new.stage is distinct from old.stage or new.owner_id is distinct from old.owner_id then
      new.last_activity_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger crm_contacts_prepare before insert or update on public.crm_contacts
  for each row execute function app.prepare_crm_contact();

create or replace function app.log_crm_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.crm_events (organization_id, contact_id, kind, to_stage, actor_id)
    values (new.organization_id, new.id, case when new.source = 'import' then 'imported' else 'created' end, new.stage, auth.uid());
    return new;
  end if;
  if new.erased_at is not null then
    return new; -- обезличивание пишет своё событие
  end if;
  if new.stage is distinct from old.stage then
    insert into public.crm_events (organization_id, contact_id, kind, from_stage, to_stage, body, actor_id)
    values (new.organization_id, new.id, 'stage_changed', old.stage, new.stage, case when new.stage = 'lost' then new.lost_reason end, auth.uid());
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into public.crm_events (organization_id, contact_id, kind, body, actor_id)
    values (new.organization_id, new.id, 'assigned', new.owner_id::text, auth.uid());
  end if;
  return new;
end;
$$;

create trigger crm_contacts_log after insert or update on public.crm_contacts
  for each row execute function app.log_crm_contact();
create trigger crm_contacts_no_delete before delete on public.crm_contacts
  for each row execute function app.forbid_mutation();

-- Событие общения обновляет «последнюю активность» контакта.
create or replace function app.touch_crm_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('note', 'call', 'message', 'meeting', 'request') then
    update public.crm_contacts set last_activity_at = now() where id = new.contact_id and erased_at is null;
  end if;
  return new;
end;
$$;

create trigger crm_events_touch after insert on public.crm_events
  for each row execute function app.touch_crm_contact();

-- ---------------------------------------------------------------------------
-- 5. Напоминания о звонках
-- ---------------------------------------------------------------------------
create table public.crm_reminders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contact_id      uuid not null references public.crm_contacts (id) on delete restrict,
  assignee_id     uuid not null references public.profiles (id) on delete restrict,
  due_at          timestamptz not null,
  note            text check (length(note) <= 500),
  status          text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done_at         timestamptz,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint crm_reminders_done_check check ((status = 'open') = (done_at is null))
);
create index crm_reminders_due_idx on public.crm_reminders (assignee_id, status, due_at);

create or replace function app.check_crm_reminder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.crm_contacts%rowtype;
begin
  select * into v_c from public.crm_contacts where id = new.contact_id;
  if v_c.erased_at is not null and new.status = 'open' then
    raise exception 'contact is erased' using errcode = '23514';
  end if;
  if new.organization_id is distinct from v_c.organization_id then
    raise exception 'reminder must belong to the contact school' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not app.profile_has_permission(new.assignee_id, v_c.organization_id, v_c.branch_id, 'lead.manage') then
    raise exception 'assignee must be a sales employee of this branch' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.contact_id, new.created_at, new.created_by) is distinct from (old.contact_id, old.created_at, old.created_by) then
    raise exception 'reminder identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger crm_reminders_check before insert or update on public.crm_reminders
  for each row execute function app.check_crm_reminder();

-- ---------------------------------------------------------------------------
-- 6. Пробные уроки из CRM — те же места, что и заявки с сайта
-- ---------------------------------------------------------------------------
create table public.crm_trial_bookings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contact_id      uuid not null references public.crm_contacts (id) on delete restrict,
  slot_id         uuid not null,
  request_id      uuid unique references public.lead_requests (id) on delete set null,
  status          text not null default 'booked' check (status in ('booked', 'attended', 'no_show', 'cancelled')),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint crm_trial_bookings_slot_fkey foreign key (organization_id, slot_id)
    references public.trial_slots (organization_id, id) on delete restrict,
  constraint crm_trial_bookings_once_key unique (contact_id, slot_id)
);

-- Занятые места слота: брони CRM + заявки с сайта, ещё не превращённые в бронь.
create or replace function app.trial_slot_taken(p_slot uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.crm_trial_bookings b where b.slot_id = p_slot and b.status in ('booked', 'attended'))::int
       + (select count(*) from public.lead_requests r
           where r.trial_slot_id = p_slot and r.status <> 'spam'
             and not exists (select 1 from public.crm_trial_bookings b where b.request_id = r.id))::int;
$$;

-- ---------------------------------------------------------------------------
-- 7. Заявка с сайта → CRM
-- ---------------------------------------------------------------------------
create or replace function app.crm_intake(p_request uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.lead_requests%rowtype;
  v_contact uuid;
  v_phone   text;
begin
  select * into v_r from public.lead_requests where id = p_request;
  if v_r.id is null or v_r.contact_id is not null then
    return v_r.contact_id;
  end if;
  v_phone := app.normalize_phone(v_r.phone);
  -- Одна блокировка на школу: две заявки одного человека одновременно дадут один контакт.
  perform pg_advisory_xact_lock(hashtextextended('crm:' || v_r.organization_id::text, 0));
  select id into v_contact from public.crm_contacts
   where organization_id = v_r.organization_id and erased_at is null
     and ((v_phone is not null and phone = v_phone) or (v_r.email is not null and email = v_r.email))
   order by created_at
   limit 1;
  if v_contact is null then
    insert into public.crm_contacts (organization_id, branch_id, full_name, phone, email, source)
    values (v_r.organization_id, v_r.branch_id, v_r.full_name, v_phone, v_r.email,
            case when v_r.kind = 'trial' then 'website_trial' else 'website_contact' end)
    returning id into v_contact;
  end if;
  update public.lead_requests set contact_id = v_contact where id = v_r.id;
  insert into public.crm_events (organization_id, contact_id, kind, channel, body)
  values (v_r.organization_id, v_contact, 'request', 'other', v_r.message);
  if v_r.kind = 'trial' then
    insert into public.crm_trial_bookings (organization_id, contact_id, slot_id, request_id)
    values (v_r.organization_id, v_contact, v_r.trial_slot_id, v_r.id)
    on conflict (contact_id, slot_id) do nothing;
    update public.crm_contacts set stage = 'trial_booked' where id = v_contact and stage in ('new', 'contacted');
    insert into public.crm_events (organization_id, contact_id, kind, body)
    values (v_r.organization_id, v_contact, 'trial_booked', v_r.trial_slot_id::text);
  end if;
  return v_contact;
end;
$$;

-- Тот же контракт submit_lead_request (этап 4); места считает app.trial_slot_taken,
-- новая заявка сразу попадает в CRM.
create or replace function public.submit_lead_request(
  p_org_slug text, p_kind text, p_branch uuid, p_full_name text, p_phone text, p_email text, p_message text,
  p_course uuid, p_slot uuid, p_locale text, p_consent_version text, p_dedupe_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_slot   public.trial_slots%rowtype;
  v_id     uuid;
  v_branch uuid := p_branch;
begin
  select id into v_org from public.organizations where slug = p_org_slug and status = 'active';
  if v_org is null then
    raise exception 'organization not available' using errcode = '22023';
  end if;
  if p_consent_version is distinct from app.current_legal_version(v_org, 'privacy') then
    raise exception 'consent version is not current' using errcode = '22023';
  end if;
  if v_branch is not null and not exists (select 1 from public.branches where id = v_branch and organization_id = v_org and status = 'active') then
    raise exception 'branch not available' using errcode = '22023';
  end if;
  if p_course is not null and not exists (select 1 from public.courses where id = p_course and organization_id = v_org and status = 'published') then
    raise exception 'course not available' using errcode = '22023';
  end if;

  if p_kind = 'trial' then
    select * into v_slot from public.trial_slots where id = p_slot and organization_id = v_org for update;
    if not found or v_slot.status <> 'open' or lower(v_slot.period) <= now() then
      raise exception 'trial slot not available' using errcode = '22023';
    end if;
    if app.trial_slot_taken(v_slot.id) >= v_slot.capacity and not exists (select 1 from public.lead_requests where dedupe_key = p_dedupe_key) then
      raise exception 'trial slot is full' using errcode = '23514';
    end if;
    v_branch := v_slot.branch_id;
  elsif p_slot is not null then
    raise exception 'slot is only allowed for trial requests' using errcode = '22023';
  end if;

  insert into public.lead_requests (organization_id, branch_id, kind, full_name, phone, email, message, course_id, trial_slot_id, locale, consent_version, dedupe_key)
  values (v_org, v_branch, p_kind, btrim(p_full_name), nullif(btrim(p_phone), ''), nullif(lower(btrim(p_email)), ''), nullif(btrim(p_message), ''),
          p_course, case when p_kind = 'trial' then p_slot end, p_locale, p_consent_version, p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.lead_requests where dedupe_key = p_dedupe_key;
  else
    perform app.crm_intake(v_id);
  end if;
  return v_id;
end;
$$;

create or replace function public.public_trial_slots(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'branchId', s.branch_id, 'branch', b.name, 'city', b.city, 'format', s.format,
    'startsAt', lower(s.period), 'endsAt', upper(s.period), 'timezone', b.timezone,
    'course', c.title,
    'freeSpots', s.capacity - app.trial_slot_taken(s.id)
  ) order by lower(s.period)), '[]'::jsonb)
  from public.trial_slots s
  join public.branches b on b.id = s.branch_id and b.status = 'active'
  left join public.courses c on c.id = s.course_id and c.status = 'published'
  where s.organization_id = app.public_org(p_slug)
    and s.status = 'open'
    and lower(s.period) > now()
    and lower(s.period) < now() + interval '60 days'
    and s.capacity > app.trial_slot_taken(s.id);
$$;

-- ---------------------------------------------------------------------------
-- 8. Действия CRM (проверки прав внутри; сотрудники — с MFA, как lead.manage)
-- ---------------------------------------------------------------------------
create or replace function app.crm_contact_for(p_contact uuid, p_permission text)
returns public.crm_contacts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.crm_contacts%rowtype;
begin
  select * into v_c from public.crm_contacts where id = p_contact;
  if v_c.id is null or app.current_aal() <> 'aal2' or not app.has_permission(v_c.organization_id, v_c.branch_id, p_permission) then
    raise exception 'contact is not available' using errcode = '42501';
  end if;
  if v_c.erased_at is not null then
    raise exception 'contact is erased' using errcode = '23514';
  end if;
  return v_c;
end;
$$;

create or replace function public.crm_book_trial(p_contact uuid, p_slot uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c    public.crm_contacts%rowtype := app.crm_contact_for(p_contact, 'lead.manage');
  v_slot public.trial_slots%rowtype;
  v_id   uuid;
begin
  select * into v_slot from public.trial_slots where id = p_slot and organization_id = v_c.organization_id for update;
  if v_slot.id is null or v_slot.status <> 'open' or lower(v_slot.period) <= now() then
    raise exception 'trial slot not available' using errcode = '22023';
  end if;
  if app.trial_slot_taken(v_slot.id) >= v_slot.capacity then
    raise exception 'trial slot is full' using errcode = '23514';
  end if;
  insert into public.crm_trial_bookings (organization_id, contact_id, slot_id, created_by)
  values (v_c.organization_id, v_c.id, v_slot.id, auth.uid())
  returning id into v_id;
  update public.crm_contacts set stage = 'trial_booked' where id = v_c.id and stage in ('new', 'contacted');
  insert into public.crm_events (organization_id, contact_id, kind, body, actor_id)
  values (v_c.organization_id, v_c.id, 'trial_booked', v_slot.id::text, auth.uid());
  return v_id;
end;
$$;

create or replace function public.crm_trial_result(p_booking uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.crm_trial_bookings%rowtype;
  v_c public.crm_contacts%rowtype;
begin
  if p_status not in ('attended', 'no_show', 'cancelled') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select * into v_b from public.crm_trial_bookings where id = p_booking;
  if v_b.id is null then
    raise exception 'contact is not available' using errcode = '42501';
  end if;
  v_c := app.crm_contact_for(v_b.contact_id, 'lead.manage');
  update public.crm_trial_bookings set status = p_status, updated_at = now() where id = p_booking;
  if p_status = 'attended' then
    update public.crm_contacts set stage = 'trial_done' where id = v_c.id and stage in ('new', 'contacted', 'trial_booked');
  end if;
  insert into public.crm_events (organization_id, contact_id, kind, body, actor_id)
  values (v_c.organization_id, v_c.id, 'trial_result', p_status, auth.uid());
end;
$$;

-- Конверсия: контакт связывается с учётной записью ученика этой школы.
create or replace function public.crm_convert(p_contact uuid, p_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.crm_contacts%rowtype := app.crm_contact_for(p_contact, 'lead.manage');
begin
  if not exists (select 1 from public.memberships m
                 where m.profile_id = p_profile and m.organization_id = v_c.organization_id and m.role = 'student' and m.status = 'active'
                   and (v_c.branch_id is null or m.branch_id = v_c.branch_id)) then
    raise exception 'profile is not a student of this branch' using errcode = '23514';
  end if;
  update public.crm_contacts set profile_id = p_profile, stage = 'won' where id = v_c.id;
  insert into public.crm_events (organization_id, contact_id, kind, actor_id)
  values (v_c.organization_id, v_c.id, 'converted', auth.uid());
end;
$$;

-- Запись ученика из CRM на курс: права на запись в филиале группы + ученик связан с контактом.
create or replace function public.crm_enroll(p_contact uuid, p_group uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c  public.crm_contacts%rowtype := app.crm_contact_for(p_contact, 'lead.read');
  v_g  public.groups%rowtype;
  v_id uuid;
begin
  if v_c.profile_id is null then
    raise exception 'contact is not converted yet' using errcode = '23514';
  end if;
  select * into v_g from public.groups where id = p_group and organization_id = v_c.organization_id;
  if v_g.id is null or not app.has_permission(v_g.organization_id, v_g.branch_id, 'enrollment.manage') then
    raise exception 'group is not available' using errcode = '42501';
  end if;
  insert into public.enrollments (organization_id, branch_id, group_id, student_id, status, created_by)
  values (v_g.organization_id, v_g.branch_id, v_g.id, v_c.profile_id, 'active', auth.uid())
  returning id into v_id;
  insert into public.crm_events (organization_id, contact_id, kind, body, actor_id)
  values (v_c.organization_id, v_c.id, 'enrolled', v_g.name, auth.uid());
  return v_id;
end;
$$;

-- Импорт: до 500 строк; дубли (в базе и внутри файла) пропускаются, а не создаются.
create or replace function public.crm_import(p_org uuid, p_branch uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row       jsonb;
  v_i         int := 0;
  v_phone     text;
  v_email     text;
  v_name      text;
  v_created   int := 0;
  v_duplicate jsonb := '[]'::jsonb;
  v_invalid   jsonb := '[]'::jsonb;
begin
  if app.current_aal() <> 'aal2' or not app.has_permission(p_org, p_branch, 'lead.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm:' || p_org::text, 0));
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_name := btrim(coalesce(v_row ->> 'fullName', ''));
    v_phone := app.normalize_phone(v_row ->> 'phone');
    v_email := nullif(lower(btrim(coalesce(v_row ->> 'email', ''))), '');
    if length(v_name) not between 1 and 120 or (v_phone is null and v_email is null)
       or (v_phone is not null and v_phone !~ '^\+?[0-9]{6,15}$')
       or (v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
      v_invalid := v_invalid || to_jsonb(v_i);
      continue;
    end if;
    if exists (select 1 from public.crm_contacts where organization_id = p_org and erased_at is null
               and ((v_phone is not null and phone = v_phone) or (v_email is not null and email = v_email))) then
      v_duplicate := v_duplicate || to_jsonb(v_i);
      continue;
    end if;
    insert into public.crm_contacts (organization_id, branch_id, full_name, phone, email, source, note, created_by)
    values (p_org, p_branch, v_name, v_phone, v_email, 'import', nullif(left(btrim(coalesce(v_row ->> 'note', '')), 2000), ''), auth.uid());
    v_created := v_created + 1;
  end loop;
  return jsonb_build_object('created', v_created, 'duplicates', v_duplicate, 'invalid', v_invalid);
end;
$$;

-- Журнал экспортов: кто, когда, сколько строк, в каком охвате.
create table public.crm_exports (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  actor_id        uuid not null,
  row_count       int not null check (row_count >= 0),
  created_at      timestamptz not null default now()
);
create trigger crm_exports_append_only before update or delete on public.crm_exports
  for each row execute function app.forbid_mutation();

-- Экспорт: только crm.admin с MFA; только поля, нужные для работы (без заметок и истории).
create or replace function public.crm_export(p_org uuid, p_branch uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  -- Без филиала — выгрузка всего охвата: школы для директора, своего филиала для менеджера.
  if app.current_aal() <> 'aal2' or not (
       app.has_permission(p_org, p_branch, 'crm.admin')
       or (p_branch is null and exists (select 1 from public.branches b where b.organization_id = p_org and app.has_permission(p_org, b.id, 'crm.admin')))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'fullName', c.full_name, 'phone', c.phone, 'email', c.email, 'source', c.source, 'stage', c.stage,
           'branch', b.name, 'owner', nullif(p.full_name, ''), 'createdAt', c.created_at, 'lastActivityAt', c.last_activity_at)
         order by c.created_at), '[]'::jsonb)
    into v_rows
    from public.crm_contacts c
    left join public.branches b on b.id = c.branch_id
    left join public.profiles p on p.id = c.owner_id
   where c.organization_id = p_org and c.erased_at is null
     and (p_branch is null or c.branch_id = p_branch)
     -- Филиальный сотрудник выгружает только свой филиал.
     and app.has_permission(c.organization_id, c.branch_id, 'crm.admin');
  insert into public.crm_exports (organization_id, branch_id, actor_id, row_count)
  values (p_org, p_branch, auth.uid(), jsonb_array_length(v_rows));
  return v_rows;
end;
$$;

-- Обезличивание контакта (удаление по запросу и по сроку хранения).
create or replace function app.crm_erase_contact(p_contact uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.crm_contacts%rowtype;
begin
  select * into v_c from public.crm_contacts where id = p_contact for update;
  if v_c.id is null or v_c.erased_at is not null then
    return;
  end if;
  perform set_config('app.crm_erasing', 'on', true);
  update public.crm_contacts
     set full_name = '—', phone = null, email = null, note = null, lost_reason = null, owner_id = null, erased_at = now()
   where id = p_contact;
  perform set_config('app.crm_erasing', 'off', true);
  update public.crm_events set body = null, redacted_at = now() where contact_id = p_contact and body is not null;
  update public.crm_reminders set note = null, status = case when status = 'open' then 'cancelled' else status end,
         done_at = coalesce(done_at, now())
   where contact_id = p_contact;
  -- Исходные заявки с сайта содержат те же данные — удаляем их целиком.
  delete from public.lead_requests where contact_id = p_contact;
  insert into public.crm_events (organization_id, contact_id, kind, body, actor_id)
  values (v_c.organization_id, p_contact, 'erased', left(p_reason, 300), auth.uid());
end;
$$;

create or replace function public.crm_erase(p_contact uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.crm_contacts%rowtype;
begin
  select * into v_c from public.crm_contacts where id = p_contact;
  if v_c.id is null or app.current_aal() <> 'aal2' or not app.has_permission(v_c.organization_id, v_c.branch_id, 'crm.admin') then
    raise exception 'contact is not available' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required' using errcode = '23514';
  end if;
  perform app.crm_erase_contact(p_contact, p_reason);
end;
$$;

-- Срок хранения: необработанные и потерянные контакты без активности дольше p_months
-- обезличиваются (запуск по расписанию — этап 13, только service role).
create or replace function public.crm_purge_stale(p_months int default 24)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if p_months < 6 then
    raise exception 'retention must be at least 6 months' using errcode = '22023';
  end if;
  for v_id in
    select id from public.crm_contacts
     where erased_at is null and profile_id is null and stage in ('new', 'contacted', 'lost')
       and last_activity_at < now() - make_interval(months => p_months)
  loop
    perform app.crm_erase_contact(v_id, 'retention period expired');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Воронка: контакты, созданные за период, по этапам и источникам (в охвате вызывающего).
create or replace function public.crm_funnel(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select * from public.crm_contacts
     where organization_id = p_org and created_at >= p_from and created_at < p_to and erased_at is null
       and app.has_permission(organization_id, branch_id, 'lead.read')
  )
  select jsonb_build_object(
    'total', (select count(*) from c),
    'won', (select count(*) from c where stage = 'won'),
    'byStage', coalesce((select jsonb_object_agg(stage, n) from (select stage, count(*) n from c group by stage) s), '{}'::jsonb),
    'bySource', coalesce((select jsonb_object_agg(source, jsonb_build_object('total', n, 'won', w))
                          from (select source, count(*) n, count(*) filter (where stage = 'won') w from c group by source) s), '{}'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------------
alter table public.crm_contacts       enable row level security;
alter table public.crm_events         enable row level security;
alter table public.crm_reminders      enable row level security;
alter table public.crm_trial_bookings enable row level security;
alter table public.crm_exports        enable row level security;

create or replace function app.can_read_contact(p_contact uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.crm_contacts c where c.id = p_contact and app.has_permission(c.organization_id, c.branch_id, 'lead.read'));
$$;

create or replace function app.can_manage_contact(p_contact uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_aal() = 'aal2' and exists (
    select 1 from public.crm_contacts c where c.id = p_contact and c.erased_at is null and app.has_permission(c.organization_id, c.branch_id, 'lead.manage'));
$$;

create policy "sales staff read contacts in scope" on public.crm_contacts
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'lead.read'));
create policy "sales staff with mfa create contacts" on public.crm_contacts
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'lead.manage')
    and created_by = (select auth.uid()) and profile_id is null and erased_at is null and stage <> 'won'
  );
create policy "sales staff with mfa update contacts" on public.crm_contacts
  for update to authenticated
  using (app.current_aal() = 'aal2' and erased_at is null and app.has_permission(organization_id, branch_id, 'lead.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'lead.manage'));

create policy "sales staff read history" on public.crm_events
  for select to authenticated using (app.can_read_contact(contact_id));
create policy "sales staff log communication" on public.crm_events
  for insert to authenticated with check (
    kind in ('note', 'call', 'message', 'meeting') and actor_id = (select auth.uid()) and redacted_at is null
    and app.can_manage_contact(contact_id)
    and organization_id = (select c.organization_id from public.crm_contacts c where c.id = contact_id)
  );

create policy "sales staff read reminders" on public.crm_reminders
  for select to authenticated using (app.can_read_contact(contact_id));
create policy "sales staff create reminders" on public.crm_reminders
  for insert to authenticated with check (app.can_manage_contact(contact_id) and created_by = (select auth.uid()) and status = 'open');
create policy "sales staff update reminders" on public.crm_reminders
  for update to authenticated using (app.can_manage_contact(contact_id)) with check (app.can_manage_contact(contact_id));

create policy "sales staff read trial bookings" on public.crm_trial_bookings
  for select to authenticated using (app.can_read_contact(contact_id));

create policy "crm admins read export log" on public.crm_exports
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'crm.admin'));

-- ---------------------------------------------------------------------------
-- 10. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.crm_contacts, public.crm_events, public.crm_reminders, public.crm_trial_bookings, public.crm_exports from anon, authenticated;
grant select, insert on public.crm_contacts to authenticated;
-- profile_id / erased_at / organization_id меняются только функциями.
grant update (branch_id, full_name, phone, email, source, stage, lost_reason, note, owner_id) on public.crm_contacts to authenticated;
grant select, insert on public.crm_events to authenticated;
grant select, insert on public.crm_reminders to authenticated;
grant update (due_at, note, status, done_at, assignee_id) on public.crm_reminders to authenticated;
grant select on public.crm_trial_bookings, public.crm_exports to authenticated;
grant all on public.crm_contacts, public.crm_events, public.crm_reminders, public.crm_trial_bookings, public.crm_exports to service_role;

revoke all on function public.crm_book_trial(uuid, uuid), public.crm_trial_result(uuid, text), public.crm_convert(uuid, uuid),
  public.crm_enroll(uuid, uuid), public.crm_import(uuid, uuid, jsonb), public.crm_export(uuid, uuid), public.crm_erase(uuid, text),
  public.crm_purge_stale(int), public.crm_funnel(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_book_trial(uuid, uuid), public.crm_trial_result(uuid, text), public.crm_convert(uuid, uuid),
  public.crm_enroll(uuid, uuid), public.crm_import(uuid, uuid, jsonb), public.crm_export(uuid, uuid), public.crm_erase(uuid, text),
  public.crm_funnel(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
revoke execute on function public.crm_purge_stale(int) from authenticated;
grant execute on function public.crm_purge_stale(int) to service_role;

grant execute on function app.can_read_contact(uuid), app.can_manage_contact(uuid), app.normalize_phone(text) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
