-- =============================================================================
-- Этап 10. Мониторинг аудиторий — безопасный базовый уровень.
--
--  * Только числа: подсчёт людей в аудитории и пересечения входной зоны. Изображений,
--    видео, лиц и идентификации учеников в схеме нет (столбцов для них нет).
--  * Уровни достоверности разделены: подсчёт (occupancy_snapshots) → пересечения
--    (zone_crossings) → идентификация (только QR/карта/преподаватель, этап 6) →
--    подтверждённая посещаемость (attendance_records). Данные камеры посещаемость
--    не меняют: расхождения идут в очередь проверки человеком.
--  * Выключено по умолчанию: включить можно только с целью, правовым основанием,
--    опубликованным уведомлением и отметкой о юридической проверке (ADR-0012).
--  * Устройства — отдельные секреты (в БД только SHA-256). Просмотр данных — через
--    функции, каждый просмотр записывается в журнал. Срок хранения ограничен.
-- =============================================================================

insert into public.permissions (code, description) values
  ('monitoring.view', 'Видеть данные мониторинга аудиторий своего охвата (с записью в журнал)'),
  ('monitoring.manage', 'Настраивать мониторинг, камеры и сроки хранения');
insert into public.role_permissions (role, permission) values
  ('org_director', 'monitoring.view'), ('org_director', 'monitoring.manage'),
  ('branch_manager', 'monitoring.view'), ('branch_manager', 'monitoring.manage'),
  ('admin', 'monitoring.view');

-- ---------------------------------------------------------------------------
-- 1. Политика мониторинга школы
-- ---------------------------------------------------------------------------
create table public.monitoring_policies (
  organization_id       uuid primary key references public.organizations (id) on delete restrict,
  enabled               boolean not null default false,
  purpose               text check (length(btrim(purpose)) between 10 and 1000),
  legal_basis           text check (length(btrim(legal_basis)) between 10 and 1000),
  notice_text           text check (length(btrim(notice_text)) between 20 and 4000),
  notice_published_at   timestamptz,
  legal_reviewed_at     timestamptz,
  legal_reviewer        text check (length(btrim(legal_reviewer)) between 3 and 200),
  -- Сырые данные (числа) — не дольше 90 дней; разобранные предупреждения — не дольше года.
  data_retention_days   int not null default 30 check (data_retention_days between 1 and 90),
  alert_retention_days  int not null default 180 check (alert_retention_days between 30 and 365),
  updated_by            uuid not null references public.profiles (id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Включить нельзя без цели, основания, опубликованного уведомления и юридической проверки.
  constraint monitoring_policies_enable_check check (
    not enabled or (purpose is not null and legal_basis is not null and notice_text is not null
                    and notice_published_at is not null and legal_reviewed_at is not null and legal_reviewer is not null)
  )
);
create trigger monitoring_policies_set_updated_at before update on public.monitoring_policies for each row execute function app.set_updated_at();
create trigger monitoring_policies_audit after insert or update on public.monitoring_policies for each row execute function app.audit_row();
create trigger monitoring_policies_no_delete before delete on public.monitoring_policies for each row execute function app.forbid_mutation();

create or replace function app.monitoring_enabled(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select enabled from public.monitoring_policies where organization_id = p_org), false);
$$;

-- ---------------------------------------------------------------------------
-- 2. Устройства
-- ---------------------------------------------------------------------------
create table public.camera_devices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  classroom_id    uuid,
  name            text not null check (length(btrim(name)) between 1 and 100),
  -- Что умеет устройство: считать людей в аудитории или фиксировать вход/выход.
  kind            text not null check (kind in ('occupancy_counter', 'entrance_counter')),
  status          text not null default 'active' check (status in ('active', 'disabled')),
  token_sha256    text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  last_seen_at    timestamptz,
  created_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint camera_devices_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete restrict,
  constraint camera_devices_classroom_fkey foreign key (organization_id, branch_id, classroom_id)
    references public.classrooms (organization_id, branch_id, id) on delete restrict
);
create trigger camera_devices_set_updated_at before update on public.camera_devices for each row execute function app.set_updated_at();
create trigger camera_devices_immutable before update on public.camera_devices
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'created_by');
create trigger camera_devices_no_delete before delete on public.camera_devices for each row execute function app.forbid_mutation();
-- Аудит без хеша токена.
create or replace function app.audit_camera()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity, entity_id, diff)
  values (new.organization_id, new.branch_id, auth.uid(), lower(tg_op), 'camera_devices', new.id,
          jsonb_build_object('name', new.name, 'kind', new.kind, 'status', new.status, 'classroomId', new.classroom_id,
                             'tokenRotated', tg_op = 'UPDATE' and new.token_sha256 is distinct from old.token_sha256));
  return new;
end;
$$;
create trigger camera_devices_audit after insert or update of name, kind, status, classroom_id, token_sha256 on public.camera_devices
  for each row execute function app.audit_camera();

-- ---------------------------------------------------------------------------
-- 3. Данные: только числа
-- ---------------------------------------------------------------------------
create table public.occupancy_snapshots (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  branch_id       uuid not null,
  classroom_id    uuid not null,
  device_id       uuid not null references public.camera_devices (id) on delete restrict,
  session_id      uuid references public.lesson_sessions (id) on delete set null,
  observed_at     timestamptz not null,
  people_count    int not null check (people_count between 0 and 500),
  received_at     timestamptz not null default now(),
  constraint occupancy_snapshots_once_key unique (device_id, observed_at)
);
create index occupancy_snapshots_room_idx on public.occupancy_snapshots (classroom_id, observed_at);
create index occupancy_snapshots_session_idx on public.occupancy_snapshots (session_id) where session_id is not null;

create table public.zone_crossings (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  branch_id       uuid not null,
  classroom_id    uuid not null,
  device_id       uuid not null references public.camera_devices (id) on delete restrict,
  session_id      uuid references public.lesson_sessions (id) on delete set null,
  direction       text not null check (direction in ('in', 'out')),
  crossed_at      timestamptz not null,
  received_at     timestamptz not null default now(),
  constraint zone_crossings_once_key unique (device_id, crossed_at, direction)
);
create index zone_crossings_room_idx on public.zone_crossings (classroom_id, crossed_at);

-- Сырые данные удаляются только процедурой хранения.
create or replace function app.guard_monitoring_data()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('app.monitoring_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'append-only: monitoring data is removed only by the retention job' using errcode = 'P0001';
end;
$$;
create trigger occupancy_snapshots_guard before update or delete on public.occupancy_snapshots for each row execute function app.guard_monitoring_data();
create trigger zone_crossings_guard before update or delete on public.zone_crossings for each row execute function app.guard_monitoring_data();

-- ---------------------------------------------------------------------------
-- 4. Предупреждения и очередь проверки
-- ---------------------------------------------------------------------------
create table public.monitoring_alerts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  classroom_id    uuid,
  session_id      uuid references public.lesson_sessions (id) on delete cascade,
  kind            text not null check (kind in ('group_absent', 'count_mismatch', 'room_occupied_unscheduled', 'device_silent')),
  -- Факты, на которых основано предупреждение (числа, а не выводы о людях).
  details         jsonb not null check (jsonb_typeof(details) = 'object' and length(details::text) <= 2000),
  status          text not null default 'open' check (status in ('open', 'confirmed', 'dismissed')),
  resolution_note text check (length(btrim(resolution_note)) between 3 and 1000),
  resolved_by     uuid references public.profiles (id) on delete restrict,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  constraint monitoring_alerts_resolution_check check ((status = 'open') = (resolved_by is null) and (status = 'open') = (resolved_at is null)
                                                       and (status = 'open' or resolution_note is not null)),
  -- Одно предупреждение одного вида на занятие (повторная проверка не дублирует).
  constraint monitoring_alerts_once_key unique (session_id, kind)
);
create index monitoring_alerts_queue_idx on public.monitoring_alerts (organization_id, branch_id, status, created_at desc);

create or replace function app.guard_alert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'open' then
    raise exception 'alert is already resolved' using errcode = '23514';
  end if;
  if (new.organization_id, new.branch_id, new.classroom_id, new.session_id, new.kind, new.details, new.created_at)
     is distinct from (old.organization_id, old.branch_id, old.classroom_id, old.session_id, old.kind, old.details, old.created_at) then
    raise exception 'alert facts are immutable' using errcode = '42501';
  end if;
  if auth.uid() is not null and new.resolved_by is distinct from auth.uid() then
    raise exception 'resolution must be signed by the reviewer' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger monitoring_alerts_guard before update on public.monitoring_alerts for each row execute function app.guard_alert();
create trigger monitoring_alerts_audit after insert or update on public.monitoring_alerts for each row execute function app.audit_row();
create trigger monitoring_alerts_no_delete before delete on public.monitoring_alerts
  for each row execute function app.guard_monitoring_data();

-- Журнал доступа к данным мониторинга (кто и что смотрел).
create table public.monitoring_access_log (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  branch_id       uuid,
  actor_id        uuid not null,
  action          text not null check (action in ('view_room', 'view_utilization', 'view_alerts', 'resolve_alert', 'manage_device', 'change_policy', 'purge')),
  target          text check (length(target) <= 200),
  created_at      timestamptz not null default now()
);
create index monitoring_access_log_org_idx on public.monitoring_access_log (organization_id, created_at desc);
create trigger monitoring_access_log_append_only before update or delete on public.monitoring_access_log
  for each row execute function app.forbid_mutation();

create or replace function app.log_monitoring_access(p_org uuid, p_branch uuid, p_action text, p_target text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.monitoring_access_log (organization_id, branch_id, actor_id, action, target)
  values (p_org, p_branch, coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'), p_action, left(p_target, 200));
$$;

-- Уведомления ответственным — тот же механизм, что изменения расписания (этап 6).
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('session_rescheduled', 'session_cancelled', 'session_changed', 'monitoring_alert'));

-- ---------------------------------------------------------------------------
-- 5. Приём данных устройств (только service role после проверки токена)
-- ---------------------------------------------------------------------------
create or replace function public.ingest_monitoring(
  p_device uuid, p_token_sha256 text, p_kind text, p_people_count int, p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d       public.camera_devices%rowtype;
  v_session uuid;
  v_id      bigint;
begin
  select * into v_d from public.camera_devices where id = p_device;
  -- Неизвестное устройство и неверный токен неразличимы для вызывающего.
  if v_d.id is null or v_d.token_sha256 <> p_token_sha256 then
    return jsonb_build_object('outcome', 'unauthorized');
  end if;
  if v_d.status <> 'active' or not app.monitoring_enabled(v_d.organization_id) then
    return jsonb_build_object('outcome', 'disabled');
  end if;
  if v_d.classroom_id is null then
    return jsonb_build_object('outcome', 'unassigned');
  end if;
  if p_observed_at is null or p_observed_at > now() + interval '5 minutes' or p_observed_at < now() - interval '2 days' then
    return jsonb_build_object('outcome', 'rejected');
  end if;
  update public.camera_devices set last_seen_at = now() where id = v_d.id;
  select id into v_session from public.lesson_sessions
   where classroom_id = v_d.classroom_id and status <> 'cancelled' and period @> p_observed_at
   limit 1;

  if p_kind = 'occupancy' and v_d.kind = 'occupancy_counter' and p_people_count between 0 and 500 then
    insert into public.occupancy_snapshots (organization_id, branch_id, classroom_id, device_id, session_id, observed_at, people_count)
    values (v_d.organization_id, v_d.branch_id, v_d.classroom_id, v_d.id, v_session, p_observed_at, p_people_count)
    on conflict (device_id, observed_at) do nothing
    returning id into v_id;
  elsif p_kind in ('in', 'out') and v_d.kind = 'entrance_counter' then
    insert into public.zone_crossings (organization_id, branch_id, classroom_id, device_id, session_id, direction, crossed_at)
    values (v_d.organization_id, v_d.branch_id, v_d.classroom_id, v_d.id, v_session, p_kind, p_observed_at)
    on conflict (device_id, crossed_at, direction) do nothing
    returning id into v_id;
  else
    return jsonb_build_object('outcome', 'rejected');
  end if;
  return jsonb_build_object('outcome', case when v_id is null then 'duplicate' else 'recorded' end, 'sessionId', v_session);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Сопоставление с расписанием → предупреждения
-- ---------------------------------------------------------------------------
-- Для завершившихся занятий за последние 2 суток в аудиториях со счётчиком:
--   group_absent — за всё занятие никого (максимум 0 при наличии данных);
--   count_mismatch — максимум людей заметно расходится с числом подтверждённо присутствующих;
-- для аудиторий без занятия — room_occupied_unscheduled (≥ 3 человек дольше 30 минут).
-- Предупреждение — повод для проверки человеком, а не вывод о конкретных учениках.
create or replace function public.monitoring_check(p_org uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s      record;
  v_max    int;
  v_n      int;
  v_marked int;
  v_enrolled int;
  v_created int := 0;
  v_id     uuid;
begin
  if auth.uid() is not null and not exists (
       select 1 from public.branches b where b.organization_id = p_org and app.has_permission(p_org, b.id, 'monitoring.view')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.monitoring_enabled(p_org) then
    return 0;
  end if;
  for v_s in
    select s.* from public.lesson_sessions s
     where s.organization_id = p_org and s.status <> 'cancelled' and s.classroom_id is not null
       and upper(s.period) between now() - interval '2 days' and now()
       and exists (select 1 from public.camera_devices d where d.classroom_id = s.classroom_id and d.kind = 'occupancy_counter' and d.status = 'active')
  loop
    select max(people_count), count(*) into v_max, v_n from public.occupancy_snapshots where session_id = v_s.id;
    if v_n = 0 then
      continue; -- нет данных — нет вывода
    end if;
    select count(*) into v_marked from public.attendance_records where session_id = v_s.id and status in ('present', 'late', 'left_early');
    select count(*) into v_enrolled from public.enrollments where group_id = v_s.group_id and status = 'active';
    v_id := null;
    if v_max = 0 and v_enrolled > 0 then
      insert into public.monitoring_alerts (organization_id, branch_id, classroom_id, session_id, kind, details)
      values (v_s.organization_id, v_s.branch_id, v_s.classroom_id, v_s.id, 'group_absent',
              jsonb_build_object('maxCount', v_max, 'snapshots', v_n, 'enrolled', v_enrolled, 'marked', v_marked))
      on conflict (session_id, kind) do nothing returning id into v_id;
    -- Учитываем преподавателя (+1) и допуск ±2 человека.
    elsif v_marked > 0 and abs(v_max - (v_marked + 1)) > 2 then
      insert into public.monitoring_alerts (organization_id, branch_id, classroom_id, session_id, kind, details)
      values (v_s.organization_id, v_s.branch_id, v_s.classroom_id, v_s.id, 'count_mismatch',
              jsonb_build_object('maxCount', v_max, 'snapshots', v_n, 'enrolled', v_enrolled, 'marked', v_marked))
      on conflict (session_id, kind) do nothing returning id into v_id;
    end if;
    if v_id is not null then
      v_created := v_created + 1;
      insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key)
      select p_org, m.profile_id, 'monitoring_alert',
             jsonb_build_object('alertId', v_id, 'sessionId', v_s.id, 'branchId', v_s.branch_id),
             'monitoring-alert:' || v_id::text
        from public.memberships m
        join public.role_permissions rp on rp.role = m.role and rp.permission = 'monitoring.view'
       where m.organization_id = p_org and m.status = 'active' and (m.branch_id is null or m.branch_id = v_s.branch_id)
      on conflict (recipient_id, dedupe_key) do nothing;
    end if;
  end loop;
  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Чтение — только через функции, с записью в журнал
-- ---------------------------------------------------------------------------
create or replace function public.monitoring_room_timeline(p_classroom uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.classrooms%rowtype;
begin
  select * into v_c from public.classrooms where id = p_classroom;
  if v_c.id is null or not app.has_permission(v_c.organization_id, v_c.branch_id, 'monitoring.view') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '7 days' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  perform app.log_monitoring_access(v_c.organization_id, v_c.branch_id, 'view_room', v_c.name);
  return jsonb_build_object(
    'snapshots', coalesce((select jsonb_agg(jsonb_build_object('at', observed_at, 'count', people_count, 'sessionId', session_id) order by observed_at)
                            from public.occupancy_snapshots where classroom_id = p_classroom and observed_at >= p_from and observed_at < p_to), '[]'::jsonb),
    'crossings', coalesce((select jsonb_agg(jsonb_build_object('at', crossed_at, 'direction', direction) order by crossed_at)
                            from public.zone_crossings where classroom_id = p_classroom and crossed_at >= p_from and crossed_at < p_to), '[]'::jsonb));
end;
$$;

-- Загрузка аудиторий: часы по расписанию, часы с людьми (интервалы 15 минут), средняя наполняемость занятий.
create or replace function public.room_utilization(p_org uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  if not exists (select 1 from public.branches b where b.organization_id = p_org and app.has_permission(p_org, b.id, 'monitoring.view')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform app.log_monitoring_access(p_org, null, 'view_utilization', to_char(p_from, 'YYYY-MM-DD') || '..' || to_char(p_to, 'YYYY-MM-DD'));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'classroomId', c.id, 'classroom', c.name, 'branch', b.name, 'capacity', c.capacity,
      'scheduledHours', round(coalesce((select sum(extract(epoch from (least(upper(s.period), p_to) - greatest(lower(s.period), p_from)))) / 3600
                                         from public.lesson_sessions s where s.classroom_id = c.id and s.status <> 'cancelled' and s.period && tstzrange(p_from, p_to)), 0)::numeric, 2),
      'occupiedHours', round((select count(distinct date_bin('15 minutes', o.observed_at, timestamptz '2000-01-01')) from public.occupancy_snapshots o
                               where o.classroom_id = c.id and o.people_count > 0 and o.observed_at >= p_from and o.observed_at < p_to) / 4.0, 2),
      'avgDuringSessions', (select round(avg(o.people_count), 1) from public.occupancy_snapshots o
                             where o.classroom_id = c.id and o.session_id is not null and o.observed_at >= p_from and o.observed_at < p_to),
      'hasCounter', exists (select 1 from public.camera_devices d where d.classroom_id = c.id and d.status = 'active'))
      order by b.name, c.name)
    from public.classrooms c
    join public.branches b on b.id = c.branch_id
    where c.organization_id = p_org and c.status = 'active' and app.has_permission(c.organization_id, c.branch_id, 'monitoring.view')
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Хранение
-- ---------------------------------------------------------------------------
create or replace function public.monitoring_purge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p  public.monitoring_policies%rowtype;
  v_s  int := 0;
  v_c  int := 0;
  v_a  int := 0;
  v_n  int;
begin
  perform set_config('app.monitoring_purge', 'on', true);
  for v_p in select * from public.monitoring_policies loop
    delete from public.occupancy_snapshots where organization_id = v_p.organization_id and observed_at < now() - make_interval(days => v_p.data_retention_days);
    get diagnostics v_n = row_count; v_s := v_s + v_n;
    delete from public.zone_crossings where organization_id = v_p.organization_id and crossed_at < now() - make_interval(days => v_p.data_retention_days);
    get diagnostics v_n = row_count; v_c := v_c + v_n;
    delete from public.monitoring_alerts where organization_id = v_p.organization_id and status <> 'open'
      and resolved_at < now() - make_interval(days => v_p.alert_retention_days);
    get diagnostics v_n = row_count; v_a := v_a + v_n;
    perform app.log_monitoring_access(v_p.organization_id, null, 'purge', v_s || '/' || v_c || '/' || v_a);
  end loop;
  -- Без политики данные хранить незачем.
  delete from public.occupancy_snapshots o where not exists (select 1 from public.monitoring_policies p where p.organization_id = o.organization_id);
  delete from public.zone_crossings z where not exists (select 1 from public.monitoring_policies p where p.organization_id = z.organization_id);
  perform set_config('app.monitoring_purge', 'off', true);
  return jsonb_build_object('snapshots', v_s, 'crossings', v_c, 'alerts', v_a);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------------
alter table public.monitoring_policies   enable row level security;
alter table public.camera_devices        enable row level security;
alter table public.occupancy_snapshots   enable row level security;
alter table public.zone_crossings        enable row level security;
alter table public.monitoring_alerts     enable row level security;
alter table public.monitoring_access_log enable row level security;

-- Уведомление о видеонаблюдении видят все участники школы.
create policy "members read the monitoring policy" on public.monitoring_policies
  for select to authenticated using (app.is_member(organization_id));
create policy "managers with mfa create the policy" on public.monitoring_policies
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'monitoring.manage') and updated_by = (select auth.uid()));
create policy "managers with mfa change the policy" on public.monitoring_policies
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'monitoring.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'monitoring.manage') and updated_by = (select auth.uid()));

create policy "viewers see devices of their branch" on public.camera_devices
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'monitoring.view'));
create policy "managers with mfa add devices" on public.camera_devices
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'monitoring.manage') and created_by = (select auth.uid()));
create policy "managers with mfa change devices" on public.camera_devices
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'monitoring.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'monitoring.manage'));

-- occupancy_snapshots / zone_crossings: без политик — читаются только функциями с журналом.

create policy "viewers see alerts of their branch" on public.monitoring_alerts
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'monitoring.view'));
create policy "viewers with mfa resolve alerts" on public.monitoring_alerts
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'monitoring.view'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'monitoring.view') and resolved_by = (select auth.uid()));

create policy "managers read the access log" on public.monitoring_access_log
  for select to authenticated using (app.has_permission(organization_id, null, 'monitoring.manage') or app.has_permission(organization_id, branch_id, 'monitoring.manage'));

-- ---------------------------------------------------------------------------
-- 10. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.monitoring_policies, public.camera_devices, public.occupancy_snapshots, public.zone_crossings,
  public.monitoring_alerts, public.monitoring_access_log from anon, authenticated;
grant select, insert on public.monitoring_policies to authenticated;
grant update (enabled, purpose, legal_basis, notice_text, notice_published_at, legal_reviewed_at, legal_reviewer,
  data_retention_days, alert_retention_days, updated_by) on public.monitoring_policies to authenticated;
-- Хеш токена устройства пользователям не отдаётся.
grant select (id, organization_id, branch_id, classroom_id, name, kind, status, last_seen_at, created_by, created_at, updated_at) on public.camera_devices to authenticated;
grant insert on public.camera_devices to authenticated;
grant update (name, classroom_id, status, token_sha256) on public.camera_devices to authenticated;
grant select on public.monitoring_alerts, public.monitoring_access_log to authenticated;
grant update (status, resolution_note, resolved_by, resolved_at) on public.monitoring_alerts to authenticated;
grant all on public.monitoring_policies, public.camera_devices, public.occupancy_snapshots, public.zone_crossings,
  public.monitoring_alerts, public.monitoring_access_log to service_role;

revoke all on function public.ingest_monitoring(uuid, text, text, int, timestamptz), public.monitoring_check(uuid),
  public.monitoring_room_timeline(uuid, timestamptz, timestamptz), public.room_utilization(uuid, timestamptz, timestamptz),
  public.monitoring_purge() from public, anon;
grant execute on function public.ingest_monitoring(uuid, text, text, int, timestamptz), public.monitoring_purge() to service_role;
grant execute on function public.monitoring_check(uuid), public.monitoring_room_timeline(uuid, timestamptz, timestamptz),
  public.room_utilization(uuid, timestamptz, timestamptz) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
