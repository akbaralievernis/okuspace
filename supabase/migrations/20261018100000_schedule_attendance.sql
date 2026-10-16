-- =============================================================================
-- Этап 6. Расписание и посещаемость.
--
--  * Занятия: серии по дням недели в поясе филиала, перенос и отмена с историей
--    (lesson_session_changes), уведомления затронутым людям (notifications).
--  * Двойное бронирование по-прежнему запрещают EXCLUDE-ограничения из 0003;
--    session_conflicts() объясняет, с чем именно конфликт.
--  * Посещаемость: события-доказательства (attendance_events, append-only) отдельно
--    от подтверждённых отметок (attendance_records, одна на «занятие + ученик»),
--    каждая версия отметки — в attendance_record_history (append-only).
--    Событие камеры само отметку не создаёт: нужен человек.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Право на исправление посещаемости (сотрудники, с MFA)
-- ---------------------------------------------------------------------------
insert into public.permissions (code, description) values
  ('attendance.manage', 'Исправлять отметки посещаемости и подтверждать события устройств');
insert into public.role_permissions (role, permission) values
  ('org_director', 'attendance.manage'), ('branch_manager', 'attendance.manage'), ('admin', 'attendance.manage');

-- ---------------------------------------------------------------------------
-- 2. Занятия: тема, заметка к изменению, автор; ключ области для внешних ключей
-- ---------------------------------------------------------------------------
alter table public.lesson_sessions
  add column topic       text check (length(btrim(topic)) between 1 and 200),
  add column change_note text check (length(change_note) <= 500),
  add column created_by  uuid references public.profiles (id) on delete set null,
  add constraint lesson_sessions_scope_key unique (organization_id, branch_id, id);

-- Правила изменения занятия: отменённое не меняется; прошедшее (done) нельзя перенести.
create or replace function app.guard_session_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'cancelled session cannot be changed' using errcode = '23514';
  end if;
  if old.status = 'done' and (new.period is distinct from old.period or new.teacher_id is distinct from old.teacher_id
                              or new.classroom_id is distinct from old.classroom_id or new.status <> 'done') then
    raise exception 'completed session cannot be rescheduled' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger lesson_sessions_guard before update on public.lesson_sessions
  for each row execute function app.guard_session_update();

-- ---------------------------------------------------------------------------
-- 3. История изменений занятий (append-only)
-- ---------------------------------------------------------------------------
create table public.lesson_session_changes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  session_id      uuid not null,
  kinds           text[] not null check (cardinality(kinds) between 1 and 5
                    and kinds <@ array['rescheduled', 'cancelled', 'room_changed', 'link_changed', 'teacher_changed']),
  old_values      jsonb not null,
  new_values      jsonb not null,
  note            text check (length(note) <= 500),
  -- Без внешнего ключа, как в audit_logs: append-only строку нельзя «обнулить» при удалении профиля.
  changed_by      uuid,
  created_at      timestamptz not null default now(),
  constraint lesson_session_changes_session_fkey foreign key (organization_id, branch_id, session_id)
    references public.lesson_sessions (organization_id, branch_id, id) on delete restrict
);
create index lesson_session_changes_session_idx on public.lesson_session_changes (session_id, created_at);

create trigger lesson_session_changes_append_only before update or delete on public.lesson_session_changes
  for each row execute function app.forbid_mutation();
create trigger lesson_session_changes_no_truncate before truncate on public.lesson_session_changes
  for each statement execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 4. Уведомления в кабинете (доставку по email/мессенджерам добавит этап 11)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  recipient_id    uuid not null references public.profiles (id) on delete cascade,
  kind            text not null check (kind in ('session_rescheduled', 'session_cancelled', 'session_changed')),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object' and length(payload::text) <= 4000),
  -- Одно событие → одно уведомление получателю, даже если триггер сработает повторно.
  dedupe_key      text not null check (length(dedupe_key) between 1 and 200),
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  constraint notifications_dedupe_key unique (recipient_id, dedupe_key)
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- Кому сообщать об изменении занятия: ученики группы (ожидающие и активные), их опекуны,
-- преподаватели группы и преподаватель занятия (старый и новый). Автор изменения — нет.
create or replace function app.session_audience(p_group uuid, p_teachers uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct r from (
    select e.student_id as r from public.enrollments e
      where e.group_id = p_group and e.status in ('pending', 'active')
    union
    select gl.guardian_id from public.enrollments e
      join public.guardian_links gl on gl.student_id = e.student_id and gl.organization_id = e.organization_id and gl.status = 'active'
      where e.group_id = p_group and e.status in ('pending', 'active')
    union
    select gt.teacher_id from public.group_teachers gt where gt.group_id = p_group
    union
    select unnest(p_teachers)
  ) x
  where r is not null and r is distinct from (select auth.uid());
$$;

create or replace function app.log_session_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kinds  text[] := '{}';
  v_change uuid;
  v_kind   text;
  v_group  text;
  v_tz     text;
begin
  if new.period is distinct from old.period then v_kinds := array_append(v_kinds, 'rescheduled'); end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then v_kinds := array_append(v_kinds, 'cancelled'); end if;
  if new.classroom_id is distinct from old.classroom_id then v_kinds := array_append(v_kinds, 'room_changed'); end if;
  if new.online_url is distinct from old.online_url then v_kinds := array_append(v_kinds, 'link_changed'); end if;
  if new.teacher_id is distinct from old.teacher_id then v_kinds := array_append(v_kinds, 'teacher_changed'); end if;
  if cardinality(v_kinds) = 0 then
    return new;
  end if;

  insert into public.lesson_session_changes (organization_id, branch_id, session_id, kinds, old_values, new_values, note, changed_by)
  values (
    new.organization_id, new.branch_id, new.id, v_kinds,
    jsonb_build_object('start', lower(old.period), 'end', upper(old.period), 'classroomId', old.classroom_id,
                       'onlineUrl', old.online_url, 'teacherId', old.teacher_id, 'status', old.status),
    jsonb_build_object('start', lower(new.period), 'end', upper(new.period), 'classroomId', new.classroom_id,
                       'onlineUrl', new.online_url, 'teacherId', new.teacher_id, 'status', new.status),
    coalesce(case when new.status = 'cancelled' and old.status <> 'cancelled' then new.cancel_reason end, new.change_note),
    auth.uid()
  )
  returning id into v_change;

  -- Уведомляем только об актуальных занятиях: правка давно прошедшего никого не касается.
  if greatest(upper(old.period), upper(new.period)) < now() then
    return new;
  end if;

  v_kind := case
    when 'cancelled' = any (v_kinds) then 'session_cancelled'
    when 'rescheduled' = any (v_kinds) then 'session_rescheduled'
    else 'session_changed'
  end;
  select g.name, b.timezone into v_group, v_tz
    from public.groups g join public.branches b on b.id = g.branch_id where g.id = new.group_id;

  insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key)
  select new.organization_id, r, v_kind,
         jsonb_build_object(
           'sessionId', new.id, 'groupId', new.group_id, 'groupName', v_group, 'timezone', v_tz, 'kinds', to_jsonb(v_kinds),
           'oldStart', lower(old.period), 'oldEnd', upper(old.period), 'newStart', lower(new.period), 'newEnd', upper(new.period),
           'note', coalesce(case when new.status = 'cancelled' then new.cancel_reason end, new.change_note)),
         'session-change:' || v_change::text
    from app.session_audience(new.group_id, array[old.teacher_id, new.teacher_id]) r
  on conflict (recipient_id, dedupe_key) do nothing;
  return new;
end;
$$;

create trigger lesson_sessions_log_change after update on public.lesson_sessions
  for each row execute function app.log_session_change();

-- ---------------------------------------------------------------------------
-- 5. Серия занятий и поиск конфликтов
-- ---------------------------------------------------------------------------
-- Серия: даты по дням недели (ISO: 1 = понедельник) с p_first_date, локальное время филиала.
-- SECURITY INVOKER: действуют RLS и EXCLUDE; конфликт откатывает всю серию и называет дату.
create or replace function public.create_session_series(
  p_group uuid, p_teacher uuid, p_classroom uuid, p_online_url text,
  p_first_date date, p_weekdays int[], p_start time, p_minutes int, p_count int, p_topic text default null
)
returns setof uuid
language plpgsql
set search_path = ''
as $$
declare
  v_org    uuid;
  v_branch uuid;
  v_tz     text;
  v_day    date := p_first_date;
  v_made   int := 0;
  v_start  timestamptz;
  v_id     uuid;
begin
  if p_count not between 1 and 200 or p_minutes not between 15 and 480
     or cardinality(p_weekdays) = 0 or not (p_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception 'invalid series parameters' using errcode = '22023';
  end if;
  select g.organization_id, g.branch_id, b.timezone into v_org, v_branch, v_tz
    from public.groups g join public.branches b on b.id = g.branch_id where g.id = p_group;
  if v_org is null then
    raise exception 'group is not available' using errcode = '42501';
  end if;

  while v_made < p_count loop
    if v_day > p_first_date + 730 then
      raise exception 'series is longer than two years' using errcode = '22023';
    end if;
    if extract(isodow from v_day)::int = any (p_weekdays) then
      -- Локальные дата и время в поясе филиала → момент времени (корректно и при переходе на летнее время).
      v_start := (v_day + p_start) at time zone v_tz;
      begin
        insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, online_url, period, topic, created_by)
        values (v_org, v_branch, p_group, p_teacher, p_classroom, nullif(p_online_url, ''),
                tstzrange(v_start, v_start + make_interval(mins => p_minutes), '[)'), nullif(btrim(coalesce(p_topic, '')), ''), auth.uid())
        returning id into v_id;
      exception when exclusion_violation then
        raise exception 'schedule conflict on %: %', v_day, sqlerrm using errcode = '23P01';
      end;
      v_made := v_made + 1;
      return next v_id;
    end if;
    v_day := v_day + 1;
  end loop;
end;
$$;

-- С чем конфликтует предложенное время. Детали чужих групп не раскрываются:
-- видно только вид конфликта и время; название группы — если она видна вызывающему.
create or replace function public.session_conflicts(
  p_branch uuid, p_teacher uuid, p_classroom uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.branches where id = p_branch;
  if v_org is null or not app.has_permission(v_org, p_branch, 'schedule.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_end <= p_start then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'kind', case when s.teacher_id = p_teacher then 'teacher' else 'classroom' end,
             'sessionId', case when app.can_read_group(s.group_id) then s.id end,
             'groupName', case when app.can_read_group(s.group_id) then g.name end,
             'start', lower(s.period), 'end', upper(s.period))
           order by lower(s.period))
      from public.lesson_sessions s
      join public.groups g on g.id = s.group_id
     where s.status <> 'cancelled'
       and s.period && tstzrange(p_start, p_end, '[)')
       and (s.id is distinct from p_exclude)
       and (s.teacher_id = p_teacher or (p_classroom is not null and s.classroom_id = p_classroom))
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Посещаемость
-- ---------------------------------------------------------------------------
-- События — доказательства от источников. Не меняются и не удаляются.
create table public.attendance_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  session_id      uuid not null,
  -- Ученик может быть неизвестен только для камеры (подсчёт людей, этап 10).
  student_id      uuid references public.profiles (id) on delete restrict,
  source          text not null check (source in ('code', 'card', 'camera')),
  kind            text not null check (kind in ('check_in', 'check_out')),
  occurred_at     timestamptz not null default now(),
  confidence      numeric(4, 3) check (confidence between 0 and 1),
  device_ref      text check (length(device_ref) <= 100),
  idempotency_key text check (length(idempotency_key) between 1 and 200),
  recorded_by     uuid, -- без FK: строка append-only

  created_at      timestamptz not null default now(),
  constraint attendance_events_session_fkey foreign key (organization_id, branch_id, session_id)
    references public.lesson_sessions (organization_id, branch_id, id) on delete restrict,
  constraint attendance_events_student_check check (student_id is not null or source = 'camera'),
  -- Повторная доставка события устройством не создаёт дубль.
  constraint attendance_events_idempotency_key unique (source, idempotency_key)
);
create index attendance_events_session_idx on public.attendance_events (session_id, student_id);
-- Код занятия отмечает вход один раз.
create unique index attendance_events_code_once_idx on public.attendance_events (session_id, student_id)
  where source = 'code' and kind = 'check_in';

create trigger attendance_events_append_only before update or delete on public.attendance_events
  for each row execute function app.forbid_mutation();
create trigger attendance_events_no_truncate before truncate on public.attendance_events
  for each statement execute function app.forbid_mutation();

-- Подтверждённая отметка: одна на «занятие + ученик».
create table public.attendance_records (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  branch_id         uuid not null,
  session_id        uuid not null,
  student_id        uuid not null references public.profiles (id) on delete restrict,
  status            text not null check (status in ('present', 'late', 'left_early', 'absent', 'excused')),
  minutes_late      int check (minutes_late between 1 and 480),
  absence_reason    text check (absence_reason in ('illness', 'family', 'transport', 'other')),
  note              text check (length(note) <= 500),
  source            text not null check (source in ('teacher', 'code', 'card', 'camera', 'admin')),
  evidence_event_id uuid references public.attendance_events (id) on delete restrict,
  change_reason     text check (length(btrim(change_reason)) between 1 and 500),
  marked_by         uuid references public.profiles (id) on delete set null,
  marked_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint attendance_records_session_fkey foreign key (organization_id, branch_id, session_id)
    references public.lesson_sessions (organization_id, branch_id, id) on delete restrict,
  constraint attendance_records_unique_key unique (session_id, student_id),
  constraint attendance_records_late_check check (minutes_late is null or status = 'late'),
  constraint attendance_records_reason_check check (absence_reason is null or status in ('absent', 'excused')),
  -- Отметка от устройства ссылается на событие; от камеры — ещё и на человека, который её подтвердил.
  constraint attendance_records_evidence_check check (source not in ('code', 'card', 'camera') or evidence_event_id is not null),
  constraint attendance_records_camera_check check (source <> 'camera' or marked_by is not null)
);
create index attendance_records_student_idx on public.attendance_records (student_id);

create table public.attendance_record_history (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  branch_id       uuid not null,
  record_id       uuid not null references public.attendance_records (id) on delete restrict,
  session_id      uuid not null,
  student_id      uuid not null,
  status          text not null,
  minutes_late    int,
  absence_reason  text,
  note            text,
  source          text not null,
  reason          text,
  changed_by      uuid,
  changed_at      timestamptz not null default now()
);
create index attendance_record_history_record_idx on public.attendance_record_history (record_id, changed_at);

create trigger attendance_record_history_append_only before update or delete on public.attendance_record_history
  for each row execute function app.forbid_mutation();
create trigger attendance_record_history_no_truncate before truncate on public.attendance_record_history
  for each statement execute function app.forbid_mutation();
create trigger attendance_records_no_delete before delete on public.attendance_records
  for each row execute function app.forbid_mutation();
create trigger attendance_records_no_truncate before truncate on public.attendance_records
  for each statement execute function app.forbid_mutation();
create trigger attendance_records_set_updated_at before update on public.attendance_records
  for each row execute function app.set_updated_at();
create trigger attendance_records_immutable before update on public.attendance_records
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'session_id', 'student_id');

-- Каждая версия отметки (создание и любое изменение) попадает в историю.
create or replace function app.record_attendance_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.status, new.minutes_late, new.absence_reason, new.note, new.source)
                          is not distinct from (old.status, old.minutes_late, old.absence_reason, old.note, old.source) then
    return new;
  end if;
  insert into public.attendance_record_history
    (organization_id, branch_id, record_id, session_id, student_id, status, minutes_late, absence_reason, note, source, reason, changed_by)
  values (new.organization_id, new.branch_id, new.id, new.session_id, new.student_id, new.status, new.minutes_late,
          new.absence_reason, new.note, new.source, case when tg_op = 'UPDATE' then new.change_reason end, auth.uid());
  return new;
end;
$$;

create trigger attendance_records_history after insert or update on public.attendance_records
  for each row execute function app.record_attendance_history();

-- Код занятия: хранится только SHA-256; один действующий код на занятие.
create table public.attendance_codes (
  session_id uuid primary key references public.lesson_sessions (id) on delete cascade,
  code_hash  bytea not null,
  expires_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. Функции посещаемости
-- ---------------------------------------------------------------------------
-- Преподаватель отмечает в окне «за 15 минут до начала — 48 часов после окончания».
create or replace function app.can_mark_session(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.lesson_sessions s
    where s.id = p_session and s.status <> 'cancelled'
      and (s.teacher_id = (select auth.uid()) or app.is_group_teacher(s.group_id))
      and now() between lower(s.period) - interval '15 minutes' and upper(s.period) + interval '48 hours'
  );
$$;

-- Сотрудник с attendance.manage и MFA: исправления в любое время после начала занятия.
create or replace function app.can_correct_attendance(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_aal() = 'aal2' and exists (
    select 1 from public.lesson_sessions s
    where s.id = p_session and s.status <> 'cancelled'
      and now() >= lower(s.period) - interval '15 minutes'
      and app.has_permission(s.organization_id, s.branch_id, 'attendance.manage')
  );
$$;

create or replace function app.can_read_attendance(p_session uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student = (select auth.uid())
      or app.is_guardian_of(p_student)
      or exists (
        select 1 from public.lesson_sessions s
        where s.id = p_session
          and (s.teacher_id = (select auth.uid()) or app.is_group_teacher(s.group_id)
               or app.has_permission(s.organization_id, s.branch_id, 'group.read'))
      );
$$;

-- Ученик, записанный на группу занятия (не отменённая и не ожидающая запись).
create or replace function app.is_session_student(p_session uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.lesson_sessions s
    join public.enrollments e on e.group_id = s.group_id and e.student_id = p_student
    where s.id = p_session and e.status in ('active', 'paused', 'completed')
  );
$$;

/**
 * Отметки преподавателя или исправления администратора, пачкой.
 * p_marks: [{ "studentId", "status", "minutesLate"?, "absenceReason"?, "note"? }].
 * Повторная отправка той же пачки ничего не меняет (одна строка на ученика, история — только при изменениях).
 */
create or replace function public.mark_attendance(p_session uuid, p_marks jsonb, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_s       public.lesson_sessions%rowtype;
  v_teacher boolean;
  v_admin   boolean;
  v_source  text;
  v_mark    jsonb;
  v_student uuid;
  v_status  text;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_changed int := 0;
  v_n       int;
begin
  select * into v_s from public.lesson_sessions where id = p_session;
  v_teacher := v_uid is not null and app.can_mark_session(p_session);
  v_admin := v_uid is not null and app.can_correct_attendance(p_session);
  if v_s.id is null or not (v_teacher or v_admin) then
    raise exception 'attendance is not available' using errcode = '42501';
  end if;
  if jsonb_typeof(p_marks) is distinct from 'array' or jsonb_array_length(p_marks) not between 1 and 200 then
    raise exception 'invalid marks' using errcode = '22023';
  end if;
  v_source := case when v_teacher then 'teacher' else 'admin' end;

  for v_mark in select * from jsonb_array_elements(p_marks) loop
    v_student := (v_mark ->> 'studentId')::uuid;
    v_status := v_mark ->> 'status';
    if not app.is_session_student(p_session, v_student) then
      raise exception 'student is not enrolled in this group' using errcode = '23514';
    end if;
    -- Исправление уже существующей отметки сотрудником (не преподавателем в окне) — только с причиной.
    if not v_teacher and v_reason is null
       and exists (select 1 from public.attendance_records where session_id = p_session and student_id = v_student) then
      raise exception 'a correction requires a reason' using errcode = '23514';
    end if;

    insert into public.attendance_records as r
      (organization_id, branch_id, session_id, student_id, status, minutes_late, absence_reason, note, source, change_reason, marked_by)
    values (v_s.organization_id, v_s.branch_id, p_session, v_student, v_status,
            case when v_status = 'late' then nullif(v_mark ->> 'minutesLate', '')::int end,
            case when v_status in ('absent', 'excused') then nullif(v_mark ->> 'absenceReason', '') end,
            nullif(btrim(coalesce(v_mark ->> 'note', '')), ''), v_source, v_reason, v_uid)
    on conflict (session_id, student_id) do update set
      status = excluded.status, minutes_late = excluded.minutes_late, absence_reason = excluded.absence_reason,
      note = excluded.note, source = excluded.source, evidence_event_id = null, change_reason = excluded.change_reason,
      marked_by = excluded.marked_by, marked_at = now()
    where (r.status, r.minutes_late, r.absence_reason, r.note)
          is distinct from (excluded.status, excluded.minutes_late, excluded.absence_reason, excluded.note);
    get diagnostics v_n = row_count;
    v_changed := v_changed + v_n;
  end loop;

  if v_s.status = 'scheduled' and now() >= lower(v_s.period) then
    update public.lesson_sessions set status = 'done' where id = p_session;
  end if;
  return v_changed;
end;
$$;

-- Код занятия для отметки учеников: 6 цифр, действует до конца занятия (не дольше 20 минут).
create or replace function public.open_attendance_code(p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code    text;
  v_expires timestamptz;
begin
  if auth.uid() is null or not (app.can_mark_session(p_session) or app.can_correct_attendance(p_session)) then
    raise exception 'attendance is not available' using errcode = '42501';
  end if;
  select least(upper(period), now() + interval '20 minutes') into v_expires from public.lesson_sessions where id = p_session;
  if v_expires <= now() then
    raise exception 'session has ended' using errcode = '23514';
  end if;
  -- Первые 8 hex-символов UUID v4 — криптостойкие случайные биты.
  v_code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into public.attendance_codes (session_id, code_hash, expires_at, created_by)
  values (p_session, sha256(convert_to(v_code, 'UTF8')), v_expires, auth.uid())
  on conflict (session_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
    created_by = excluded.created_by, created_at = now();
  return jsonb_build_object('code', v_code, 'expiresAt', v_expires);
end;
$$;

-- Ученик вводит код: событие + отметка «присутствует/опоздал», если преподаватель ещё не отметил.
-- Возвращает id занятия или null, если код неверен или истёк.
create or replace function public.check_in_with_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_s       public.lesson_sessions%rowtype;
  v_event   uuid;
  v_late    int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- 6 цифр подбираются перебором — ограничиваем попытки.
  if not public.hit_rate_limit('attendance_code:' || encode(sha256(convert_to('attendance_code' || v_uid::text, 'UTF8')), 'hex'), 10, 600) then
    raise exception 'too many attempts' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  -- Неверный код — не исключение, а null: исключение откатило бы и счётчик попыток.
  if p_code is null or p_code !~ '^\d{6}$' then
    return null;
  end if;

  select s.* into v_s
    from public.attendance_codes c
    join public.lesson_sessions s on s.id = c.session_id
   where c.code_hash = sha256(convert_to(p_code, 'UTF8')) and c.expires_at > now()
     and s.status <> 'cancelled' and now() >= lower(s.period) - interval '15 minutes'
     and app.is_session_student(s.id, v_uid)
   limit 1;
  if v_s.id is null then
    return null;
  end if;

  insert into public.attendance_events (organization_id, branch_id, session_id, student_id, source, kind, recorded_by)
  values (v_s.organization_id, v_s.branch_id, v_s.id, v_uid, 'code', 'check_in', v_uid)
  on conflict (session_id, student_id) where source = 'code' and kind = 'check_in' do nothing
  returning id into v_event;
  if v_event is null then
    return v_s.id; -- уже отмечался этим кодом
  end if;

  -- Опоздание — больше 10 минут после начала.
  v_late := case when now() > lower(v_s.period) + interval '10 minutes'
                 then least(480, ceil(extract(epoch from now() - lower(v_s.period)) / 60)::int) end;
  insert into public.attendance_records
    (organization_id, branch_id, session_id, student_id, status, minutes_late, source, evidence_event_id, marked_by)
  values (v_s.organization_id, v_s.branch_id, v_s.id, v_uid, case when v_late is null then 'present' else 'late' end,
          v_late, 'code', v_event, v_uid)
  on conflict (session_id, student_id) do nothing;
  return v_s.id;
end;
$$;

-- Приём событий от устройств (карта, камера) — только сервер интеграции (service role).
-- Карта создаёт отметку, если её ещё нет; камера — только событие для ручной проверки.
create or replace function public.ingest_attendance_event(
  p_session uuid, p_student uuid, p_source text, p_kind text, p_occurred_at timestamptz,
  p_idempotency_key text, p_device_ref text default null, p_confidence numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s     public.lesson_sessions%rowtype;
  v_event uuid;
  v_late  int;
begin
  if p_source not in ('card', 'camera') then
    raise exception 'unsupported source' using errcode = '22023';
  end if;
  select * into v_s from public.lesson_sessions where id = p_session;
  if v_s.id is null or v_s.status = 'cancelled' then
    raise exception 'session is not available' using errcode = '23514';
  end if;
  if p_student is not null and not app.is_session_student(p_session, p_student) then
    raise exception 'student is not enrolled in this group' using errcode = '23514';
  end if;

  insert into public.attendance_events
    (organization_id, branch_id, session_id, student_id, source, kind, occurred_at, confidence, device_ref, idempotency_key)
  values (v_s.organization_id, v_s.branch_id, p_session, p_student, p_source, p_kind, p_occurred_at, p_confidence, p_device_ref, p_idempotency_key)
  on conflict (source, idempotency_key) do nothing
  returning id into v_event;
  if v_event is null then
    select id into v_event from public.attendance_events where source = p_source and idempotency_key = p_idempotency_key;
    return v_event;
  end if;

  if p_source = 'card' and p_kind = 'check_in' and p_student is not null
     and p_occurred_at between lower(v_s.period) - interval '30 minutes' and upper(v_s.period) then
    v_late := case when p_occurred_at > lower(v_s.period) + interval '10 minutes'
                   then least(480, ceil(extract(epoch from p_occurred_at - lower(v_s.period)) / 60)::int) end;
    insert into public.attendance_records
      (organization_id, branch_id, session_id, student_id, status, minutes_late, source, evidence_event_id)
    values (v_s.organization_id, v_s.branch_id, p_session, p_student, case when v_late is null then 'present' else 'late' end,
            v_late, 'card', v_event)
    on conflict (session_id, student_id) do nothing;
  end if;
  return v_event;
end;
$$;

-- Человек подтверждает событие камеры → отметка «присутствует» со ссылкой на событие.
create or replace function public.confirm_camera_event(p_event uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e  public.attendance_events%rowtype;
  v_id uuid;
begin
  select * into v_e from public.attendance_events where id = p_event;
  if v_e.id is null or v_e.source <> 'camera' or v_e.student_id is null then
    raise exception 'event cannot be confirmed' using errcode = '23514';
  end if;
  if auth.uid() is null or not (app.can_mark_session(v_e.session_id) or app.can_correct_attendance(v_e.session_id)) then
    raise exception 'attendance is not available' using errcode = '42501';
  end if;
  insert into public.attendance_records as r
    (organization_id, branch_id, session_id, student_id, status, source, evidence_event_id, change_reason, marked_by)
  values (v_e.organization_id, v_e.branch_id, v_e.session_id, v_e.student_id, 'present', 'camera', v_e.id,
          nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (session_id, student_id) do update set
    status = 'present', minutes_late = null, absence_reason = null, source = 'camera', evidence_event_id = excluded.evidence_event_id,
    change_reason = excluded.change_reason, marked_by = excluded.marked_by, marked_at = now()
  returning r.id into v_id;
  return v_id;
end;
$$;

-- Занятия за период для календаря. SECURITY INVOKER: видно ровно то, что разрешает RLS
-- (ученик — свои группы, преподаватель — свои, сотрудник — свой охват). Отметки — только свои
-- и подопечных: журнал группы смотрят на странице занятия.
create or replace function public.schedule_window(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'organizationId', s.organization_id, 'branchId', s.branch_id, 'branchName', b.name, 'timezone', b.timezone,
             'groupId', s.group_id, 'groupName', g.name, 'teacherId', s.teacher_id, 'teacherName', nullif(tp.full_name, ''),
             'classroomId', s.classroom_id, 'classroomName', c.name, 'onlineUrl', s.online_url,
             'start', lower(s.period), 'end', upper(s.period), 'status', s.status, 'topic', s.topic, 'cancelReason', s.cancel_reason,
             'marks', coalesce((
               select jsonb_agg(jsonb_build_object('studentId', r.student_id, 'studentName', nullif(sp.full_name, ''), 'status', r.status))
                 from public.attendance_records r
                 left join public.profiles sp on sp.id = r.student_id
                where r.session_id = s.id
                  and (r.student_id = (select auth.uid()) or app.is_guardian_of(r.student_id))
             ), '[]'::jsonb))
           order by lower(s.period))
      from public.lesson_sessions s
      join public.groups g on g.id = s.group_id
      join public.branches b on b.id = s.branch_id
      left join public.classrooms c on c.id = s.classroom_id
      left join public.profiles tp on tp.id = s.teacher_id
     where s.period && tstzrange(p_from, p_to, '[)')
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------
alter table public.lesson_session_changes    enable row level security;
alter table public.notifications             enable row level security;
alter table public.attendance_events         enable row level security;
alter table public.attendance_records        enable row level security;
alter table public.attendance_record_history enable row level security;
alter table public.attendance_codes          enable row level security;

create policy "group readers read session changes" on public.lesson_session_changes
  for select to authenticated using (
    exists (select 1 from public.lesson_sessions s where s.id = session_id and app.can_read_group(s.group_id))
  );

create policy "recipients read own notifications" on public.notifications
  for select to authenticated using (recipient_id = (select auth.uid()));
create policy "recipients mark own notifications read" on public.notifications
  for update to authenticated using (recipient_id = (select auth.uid())) with check (recipient_id = (select auth.uid()));

create policy "permitted users read attendance events" on public.attendance_events
  for select to authenticated using (
    (student_id is not null and app.can_read_attendance(session_id, student_id))
    or exists (select 1 from public.lesson_sessions s where s.id = session_id
               and (s.teacher_id = (select auth.uid()) or app.is_group_teacher(s.group_id)
                    or app.has_permission(s.organization_id, s.branch_id, 'group.read')))
  );
create policy "permitted users read attendance records" on public.attendance_records
  for select to authenticated using (app.can_read_attendance(session_id, student_id));
create policy "permitted users read attendance history" on public.attendance_record_history
  for select to authenticated using (app.can_read_attendance(session_id, student_id));
-- attendance_codes: без политик — коды читают только функции (хранится лишь хеш).

-- ---------------------------------------------------------------------------
-- 9. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.lesson_session_changes, public.notifications, public.attendance_events, public.attendance_records,
  public.attendance_record_history, public.attendance_codes from anon, authenticated;
grant select on public.lesson_session_changes, public.notifications, public.attendance_events, public.attendance_records,
  public.attendance_record_history to authenticated;
-- Получатель меняет только отметку «прочитано».
grant update (read_at) on public.notifications to authenticated;
grant all on public.lesson_session_changes, public.notifications, public.attendance_events, public.attendance_records,
  public.attendance_record_history, public.attendance_codes to service_role;

revoke all on function public.create_session_series(uuid, uuid, uuid, text, date, int[], time, int, int, text),
  public.session_conflicts(uuid, uuid, uuid, timestamptz, timestamptz, uuid),
  public.mark_attendance(uuid, jsonb, text), public.open_attendance_code(uuid), public.check_in_with_code(text),
  public.ingest_attendance_event(uuid, uuid, text, text, timestamptz, text, text, numeric),
  public.confirm_camera_event(uuid, text), public.schedule_window(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.create_session_series(uuid, uuid, uuid, text, date, int[], time, int, int, text),
  public.session_conflicts(uuid, uuid, uuid, timestamptz, timestamptz, uuid),
  public.mark_attendance(uuid, jsonb, text), public.open_attendance_code(uuid), public.check_in_with_code(text),
  public.confirm_camera_event(uuid, text), public.schedule_window(timestamptz, timestamptz)
  to authenticated, service_role;
revoke execute on function public.ingest_attendance_event(uuid, uuid, text, text, timestamptz, text, text, numeric) from authenticated;
grant execute on function public.ingest_attendance_event(uuid, uuid, text, text, timestamptz, text, text, numeric) to service_role;

grant execute on function app.can_read_attendance(uuid, uuid) to authenticated, service_role;

-- Права на функции app: только явно выданные выше.
revoke execute on all functions in schema app from public, anon;
