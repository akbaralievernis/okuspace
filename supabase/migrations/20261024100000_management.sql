-- =============================================================================
-- Блок A. Управление филиалами: задачи сотрудникам, объявления, панель показателей.
--
--  * staff_tasks — задача одному сотруднику (рассылка в несколько филиалов = несколько
--    задач с общим batch_id: каждая выполняется и принимается отдельно). Статусы:
--    open → in_progress → submitted → done; руководитель может вернуть на доработку
--    (→ in_progress) или отменить. Каждый шаг — запись в staff_task_events (append-only).
--  * Таблицы задач меняются только функциями: исполнитель берёт в работу и сдаёт отчёт,
--    руководитель (task.manage, MFA) ставит, принимает, возвращает, отменяет. Свою
--    собственную задачу руководитель не принимает и не отменяет.
--  * announcements — объявление филиалу (или всей школе) для выбранных ролей. Получатели
--    фиксируются при публикации (announcement_recipients): видно, кто прочитал и кто
--    подтвердил ознакомление. Текст после публикации не меняется.
--  * branch_dashboard — показатели по филиалам за период; определения — SCHEMA.md §14.
--    Финансы видны только при finance.read в филиале.
-- =============================================================================

insert into public.permissions (code, description) values
  ('task.manage', 'Ставить задачи сотрудникам, принимать, возвращать и отменять их'),
  ('announcement.publish', 'Публиковать объявления для филиала или школы'),
  ('dashboard.read', 'Видеть панель показателей филиала');
insert into public.role_permissions (role, permission) values
  ('org_director', 'task.manage'), ('branch_manager', 'task.manage'),
  ('org_director', 'announcement.publish'), ('branch_manager', 'announcement.publish'), ('admin', 'announcement.publish'),
  ('org_director', 'dashboard.read'), ('branch_manager', 'dashboard.read'), ('admin', 'dashboard.read');

insert into public.notification_kinds (code, optional, important) values
  ('task_assigned', false, true), ('task_submitted', false, true), ('task_returned', false, true),
  ('task_accepted', true, false), ('task_cancelled', true, false), ('task_comment', true, false),
  ('task_overdue', false, true), ('announcement', true, false), ('announcement_ack', false, true);

-- ---------------------------------------------------------------------------
-- 1. Задачи
-- ---------------------------------------------------------------------------
create table public.staff_tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  batch_id        uuid not null,
  title           text not null check (length(btrim(title)) between 2 and 200),
  description     text check (length(description) <= 5000),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  due_at          timestamptz,
  assignee_id     uuid not null references public.profiles (id) on delete restrict,
  created_by      uuid not null references public.profiles (id) on delete restrict,
  status          text not null default 'open' check (status in ('open', 'in_progress', 'submitted', 'done', 'cancelled')),
  result_note     text check (length(result_note) <= 5000),
  submitted_at    timestamptz,
  completed_at    timestamptz,
  cancel_reason   text check (length(btrim(cancel_reason)) between 1 and 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint staff_tasks_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint staff_tasks_batch_assignee_key unique (batch_id, assignee_id),
  constraint staff_tasks_report_check check (status not in ('submitted', 'done') or (submitted_at is not null and result_note is not null)),
  constraint staff_tasks_completed_check check ((status = 'done') = (completed_at is not null)),
  constraint staff_tasks_cancelled_check check ((status = 'cancelled') = (cancel_reason is not null))
);
create index staff_tasks_scope_idx on public.staff_tasks (organization_id, branch_id, status);
create index staff_tasks_assignee_idx on public.staff_tasks (assignee_id, status);
create index staff_tasks_batch_idx on public.staff_tasks (batch_id);
create index staff_tasks_due_idx on public.staff_tasks (due_at) where status in ('open', 'in_progress');

create trigger staff_tasks_set_updated_at before update on public.staff_tasks
  for each row execute function app.set_updated_at();

create table public.staff_task_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  task_id         uuid not null references public.staff_tasks (id) on delete restrict,
  kind            text not null check (kind in ('created', 'started', 'submitted', 'accepted', 'returned', 'cancelled', 'comment')),
  body            text check (length(body) <= 5000),
  actor_id        uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index staff_task_events_task_idx on public.staff_task_events (task_id, created_at);

create trigger staff_task_events_append_only before update or delete on public.staff_task_events
  for each row execute function app.forbid_mutation();

-- Кому можно поставить задачу: активный сотрудник (не директор, не ученик, не родитель)
-- этого филиала; для задачи уровня школы — сотрудник без филиала (например, бухгалтер).
create or replace function app.task_assignable(p_org uuid, p_branch uuid, p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = p_org and m.profile_id = p_profile and m.status = 'active'
      and m.role in ('branch_manager', 'admin', 'sales_manager', 'accountant', 'teacher')
      and (m.branch_id is null or m.branch_id = p_branch)
  );
$$;

create or replace function app.display_name(p_profile uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif((select full_name from public.profiles where id = p_profile), ''), '—');
$$;

create or replace function app.org_timezone(p_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select default_timezone from public.organizations where id = p_org;
$$;

-- p_targets: [{"profileId": "...", "branchId": "..." | null}, ...] — до 50 исполнителей.
create or replace function public.task_create(p_org uuid, p_targets jsonb, p_title text, p_description text, p_priority text, p_due_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch    uuid := gen_random_uuid();
  v_target   jsonb;
  v_branch   uuid;
  v_assignee uuid;
  v_id       uuid;
  v_title    text := btrim(coalesce(p_title, ''));
  v_priority text := coalesce(p_priority, 'normal');
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_targets) is distinct from 'array' or jsonb_array_length(p_targets) not between 1 and 50 then
    raise exception 'invalid targets' using errcode = '22023';
  end if;
  if p_due_at is not null and p_due_at <= now() then
    raise exception 'due date must be in the future' using errcode = '22023';
  end if;
  for v_target in select value from jsonb_array_elements(p_targets) loop
    v_branch := nullif(v_target ->> 'branchId', '')::uuid;
    v_assignee := (v_target ->> 'profileId')::uuid;
    if not app.has_permission(p_org, v_branch, 'task.manage') then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_assignee = auth.uid() or not app.task_assignable(p_org, v_branch, v_assignee) then
      raise exception 'assignee is not staff of this branch' using errcode = '23514';
    end if;
    insert into public.staff_tasks (organization_id, branch_id, batch_id, title, description, priority, due_at, assignee_id, created_by)
    values (p_org, v_branch, v_batch, v_title, nullif(btrim(p_description), ''), v_priority, p_due_at, v_assignee, auth.uid())
    returning id into v_id;
    insert into public.staff_task_events (organization_id, task_id, kind, actor_id) values (p_org, v_id, 'created', auth.uid());
    perform app.notify(p_org, v_assignee, 'task_assigned',
      jsonb_build_object('taskId', v_id, 'title', v_title, 'dueAt', p_due_at, 'priority', v_priority,
                         'actorName', app.display_name(auth.uid()), 'timezone', app.org_timezone(p_org)),
      'task-assigned:' || v_id);
  end loop;
  return v_batch;
end;
$$;

-- Действия: start / submit (исполнитель), accept / return / cancel (руководитель с MFA:
-- автор задачи или директор школы; свою собственную задачу — нельзя).
create or replace function public.task_transition(p_task uuid, p_action text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.staff_tasks%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_kind text;
  v_to   uuid;
  v_new  text;
begin
  select * into v from public.staff_tasks where id = p_task for update;
  if v.id is null then
    raise exception 'task is not available' using errcode = '42501';
  end if;

  if p_action in ('start', 'submit') then
    if v.assignee_id is distinct from auth.uid() then
      raise exception 'task is not available' using errcode = '42501';
    end if;
    if p_action = 'start' then
      if v.status <> 'open' then
        raise exception 'invalid transition' using errcode = '22023';
      end if;
      v_new := 'in_progress';
      update public.staff_tasks set status = v_new where id = v.id;
    else
      if v.status not in ('open', 'in_progress') then
        raise exception 'invalid transition' using errcode = '22023';
      end if;
      if v_note is null or length(v_note) > 5000 then
        raise exception 'report required' using errcode = '23514';
      end if;
      v_new := 'submitted';
      update public.staff_tasks set status = v_new, result_note = v_note, submitted_at = now() where id = v.id;
      v_kind := 'task_submitted';
      v_to := v.created_by;
    end if;
  elsif p_action in ('accept', 'return', 'cancel') then
    if app.current_aal() <> 'aal2' or v.assignee_id = auth.uid()
       or not app.has_permission(v.organization_id, v.branch_id, 'task.manage')
       or not (v.created_by = auth.uid() or app.has_permission(v.organization_id, null, 'task.manage')) then
      raise exception 'task is not available' using errcode = '42501';
    end if;
    if p_action = 'accept' then
      if v.status <> 'submitted' then
        raise exception 'invalid transition' using errcode = '22023';
      end if;
      v_new := 'done';
      update public.staff_tasks set status = v_new, completed_at = now() where id = v.id;
      v_kind := 'task_accepted';
    elsif p_action = 'return' then
      if v.status <> 'submitted' then
        raise exception 'invalid transition' using errcode = '22023';
      end if;
      if v_note is null then
        raise exception 'comment required' using errcode = '23514';
      end if;
      v_new := 'in_progress';
      update public.staff_tasks set status = v_new where id = v.id;
      v_kind := 'task_returned';
    else
      if v.status not in ('open', 'in_progress', 'submitted') then
        raise exception 'invalid transition' using errcode = '22023';
      end if;
      if v_note is null or length(v_note) > 500 then
        raise exception 'reason required' using errcode = '23514';
      end if;
      v_new := 'cancelled';
      update public.staff_tasks set status = v_new, cancel_reason = v_note where id = v.id;
      v_kind := 'task_cancelled';
    end if;
    v_to := v.assignee_id;
  else
    raise exception 'unknown action' using errcode = '22023';
  end if;

  insert into public.staff_task_events (organization_id, task_id, kind, body, actor_id)
  values (v.organization_id, v.id,
          case p_action when 'start' then 'started' when 'submit' then 'submitted' when 'accept' then 'accepted'
                        when 'return' then 'returned' else 'cancelled' end,
          v_note, auth.uid());
  if v_kind is not null then
    perform app.notify(v.organization_id, v_to, v_kind,
      jsonb_build_object('taskId', v.id, 'title', v.title, 'dueAt', v.due_at, 'note', left(v_note, 300),
                         'actorName', app.display_name(auth.uid()), 'timezone', app.org_timezone(v.organization_id)),
      v_kind || ':' || v.id || ':' || extract(epoch from clock_timestamp())::text);
  end if;
  return v_new;
end;
$$;

-- Комментарий: исполнитель или руководитель, который видит задачу. Уведомляется другая сторона.
create or replace function public.task_comment(p_task uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.staff_tasks%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
  v_id   uuid;
begin
  select * into v from public.staff_tasks where id = p_task;
  if v.id is null or not (v.assignee_id = auth.uid()
     or (app.current_aal() = 'aal2' and app.has_permission(v.organization_id, v.branch_id, 'task.manage'))) then
    raise exception 'task is not available' using errcode = '42501';
  end if;
  if length(v_body) not between 1 and 2000 then
    raise exception 'comment length' using errcode = '23514';
  end if;
  insert into public.staff_task_events (organization_id, task_id, kind, body, actor_id)
  values (v.organization_id, v.id, 'comment', v_body, auth.uid())
  returning id into v_id;
  perform app.notify(v.organization_id, case when auth.uid() = v.assignee_id then v.created_by else v.assignee_id end, 'task_comment',
    jsonb_build_object('taskId', v.id, 'title', v.title, 'note', left(v_body, 300), 'actorName', app.display_name(auth.uid())),
    'task-comment:' || v_id);
  return v_id;
end;
$$;

-- Просроченные задачи: одно напоминание исполнителю и одно — автору (по расписанию, service role).
create or replace function public.generate_task_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.staff_tasks%rowtype;
  v_n    int := 0;
begin
  for v_task in select * from public.staff_tasks where status in ('open', 'in_progress') and due_at < p_now loop
    perform app.notify(v_task.organization_id, v_task.assignee_id, 'task_overdue',
      jsonb_build_object('taskId', v_task.id, 'title', v_task.title, 'dueAt', v_task.due_at, 'actorName', app.display_name(v_task.assignee_id),
                         'timezone', app.org_timezone(v_task.organization_id)),
      'task-overdue:' || v_task.id);
    perform app.notify(v_task.organization_id, v_task.created_by, 'task_overdue',
      jsonb_build_object('taskId', v_task.id, 'title', v_task.title, 'dueAt', v_task.due_at, 'actorName', app.display_name(v_task.assignee_id),
                         'timezone', app.org_timezone(v_task.organization_id)),
      'task-overdue:' || v_task.id);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('overdueTasks', v_n);
end;
$$;

create or replace function app.can_see_task(p_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_tasks t
    where t.id = p_task and (t.assignee_id = auth.uid() or app.has_permission(t.organization_id, t.branch_id, 'task.manage'))
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Объявления
-- ---------------------------------------------------------------------------
create table public.announcements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  title           text not null check (length(btrim(title)) between 2 and 200),
  body            text not null check (length(btrim(body)) between 1 and 10000),
  audience        text[] not null check (
    cardinality(audience) between 1 and 8
    and audience <@ array['org_director', 'branch_manager', 'admin', 'sales_manager', 'accountant', 'teacher', 'student', 'parent']
  ),
  requires_ack    boolean not null default false,
  status          text not null default 'published' check (status in ('published', 'archived')),
  recipient_count int not null default 0 check (recipient_count >= 0),
  published_by    uuid not null references public.profiles (id) on delete restrict,
  published_at    timestamptz not null default now(),
  archived_at     timestamptz,
  constraint announcements_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint announcements_archive_check check ((status = 'archived') = (archived_at is not null))
);
create index announcements_scope_idx on public.announcements (organization_id, branch_id, published_at desc);

create table public.announcement_recipients (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  read_at         timestamptz,
  acknowledged_at timestamptz,
  primary key (announcement_id, profile_id),
  constraint announcement_recipients_ack_check check (acknowledged_at is null or read_at is not null)
);
create index announcement_recipients_profile_idx on public.announcement_recipients (profile_id, announcement_id);

-- Текст, адресаты и автор после публикации не меняются; меняется только архивирование.
create or replace function app.guard_announcement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'announcements are archived, not deleted' using errcode = '42501';
  end if;
  if (new.organization_id, new.branch_id, new.title, new.body, new.audience, new.requires_ack, new.published_by, new.published_at)
     is distinct from (old.organization_id, old.branch_id, old.title, old.body, old.audience, old.requires_ack, old.published_by, old.published_at) then
    raise exception 'published announcement is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger announcements_guard before update or delete on public.announcements
  for each row execute function app.guard_announcement();

create or replace function public.announcement_publish(p_org uuid, p_branch uuid, p_title text, p_body text, p_audience text[], p_requires_ack boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_n     int;
  v_kind  text := case when p_requires_ack then 'announcement_ack' else 'announcement' end;
  v_title text := btrim(coalesce(p_title, ''));
  v_rcpt  uuid;
begin
  if app.current_aal() <> 'aal2' or not app.has_permission(p_org, p_branch, 'announcement.publish') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.announcements (organization_id, branch_id, title, body, audience, requires_ack, published_by)
  values (p_org, p_branch, v_title, btrim(coalesce(p_body, '')), p_audience, coalesce(p_requires_ack, false), auth.uid())
  returning id into v_id;
  -- Получатели — участники с выбранными ролями в филиале (или во всей школе), кроме автора.
  insert into public.announcement_recipients (announcement_id, profile_id, organization_id)
  select distinct v_id, m.profile_id, p_org
  from public.memberships m
  where m.organization_id = p_org and m.status = 'active' and m.role = any (p_audience)
    and (p_branch is null or m.branch_id = p_branch) and m.profile_id <> auth.uid();
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'no recipients' using errcode = '23514';
  end if;
  update public.announcements set recipient_count = v_n where id = v_id;
  for v_rcpt in select profile_id from public.announcement_recipients where announcement_id = v_id loop
    perform app.notify(p_org, v_rcpt, v_kind,
      jsonb_build_object('announcementId', v_id, 'title', v_title, 'actorName', app.display_name(auth.uid())),
      'announcement:' || v_id);
  end loop;
  return v_id;
end;
$$;

create or replace function public.announcement_read(p_id uuid, p_ack boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ack boolean;
begin
  select a.requires_ack into v_ack
  from public.announcements a join public.announcement_recipients r on r.announcement_id = a.id and r.profile_id = auth.uid()
  where a.id = p_id;
  if v_ack is null then
    raise exception 'announcement is not available' using errcode = '42501';
  end if;
  if p_ack and not v_ack then
    raise exception 'acknowledgement is not requested' using errcode = '22023';
  end if;
  update public.announcement_recipients
     set read_at = coalesce(read_at, now()),
         acknowledged_at = case when p_ack then coalesce(acknowledged_at, now()) else acknowledged_at end
   where announcement_id = p_id and profile_id = auth.uid();
end;
$$;

create or replace function public.announcement_archive(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.announcements%rowtype;
begin
  select * into v from public.announcements where id = p_id for update;
  if v.id is null or app.current_aal() <> 'aal2' or not app.has_permission(v.organization_id, v.branch_id, 'announcement.publish')
     or not (v.published_by = auth.uid() or app.has_permission(v.organization_id, null, 'announcement.publish')) then
    raise exception 'announcement is not available' using errcode = '42501';
  end if;
  update public.announcements set status = 'archived', archived_at = coalesce(archived_at, now()) where id = v.id;
end;
$$;

create or replace function app.is_announcement_recipient(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.announcement_recipients r where r.announcement_id = p_id and r.profile_id = auth.uid());
$$;

create or replace function app.can_manage_announcement(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.announcements a where a.id = p_id and app.has_permission(a.organization_id, a.branch_id, 'announcement.publish'));
$$;

-- Сколько прочитали и подтвердили — только для тех, кто публикует в охвате объявления.
create or replace function public.announcement_stats(p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(a.id, jsonb_build_object(
           'recipients', a.recipient_count,
           'read', (select count(*) from public.announcement_recipients r where r.announcement_id = a.id and r.read_at is not null),
           'acknowledged', (select count(*) from public.announcement_recipients r where r.announcement_id = a.id and r.acknowledged_at is not null))), '{}'::jsonb)
  from public.announcements a
  where a.id = any (p_ids[1:200]) and app.has_permission(a.organization_id, a.branch_id, 'announcement.publish');
$$;

-- ---------------------------------------------------------------------------
-- 3. Панель показателей (определения — SCHEMA.md §14)
-- ---------------------------------------------------------------------------
create or replace function public.branch_dashboard(p_org uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz    text := app.org_timezone(p_org);
  v_from  timestamptz;
  v_to    timestamptz;
  v_today date;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  if v_tz is null then
    return '[]'::jsonb;
  end if;
  v_from := p_from::timestamp at time zone v_tz;
  v_to := (p_to + 1)::timestamp at time zone v_tz;
  v_today := (now() at time zone v_tz)::date;

  return coalesce((
    select jsonb_agg(row_data order by row_data ->> 'branch')
    from (
      select jsonb_build_object(
        'branchId', b.id,
        'branch', b.name,
        'students', (select count(distinct e.student_id) from public.enrollments e where e.branch_id = b.id and e.status = 'active'),
        'groups', (select count(*) from public.groups g where g.branch_id = b.id and g.status in ('planned', 'active')),
        'teachers', (select count(distinct gt.teacher_id) from public.group_teachers gt join public.groups g on g.id = gt.group_id
                      where gt.branch_id = b.id and g.status in ('planned', 'active')),
        'sessions', (select jsonb_build_object(
                        'planned', count(*) filter (where s.status <> 'cancelled'),
                        'done', count(*) filter (where s.status = 'done'),
                        'cancelled', count(*) filter (where s.status = 'cancelled'),
                        'unmarked', count(*) filter (where s.status <> 'cancelled' and upper(s.period) <= now()
                                                     and not exists (select 1 from public.attendance_records ar where ar.session_id = s.id)))
                      from public.lesson_sessions s
                      where s.branch_id = b.id and lower(s.period) >= v_from and lower(s.period) < v_to),
        'attendance', (select jsonb_build_object(
                          'marked', count(*) filter (where ar.status <> 'excused'),
                          'present', count(*) filter (where ar.status in ('present', 'late', 'left_early')))
                        from public.attendance_records ar join public.lesson_sessions s on s.id = ar.session_id
                        where s.branch_id = b.id and lower(s.period) >= v_from and lower(s.period) < v_to),
        'homework', (select jsonb_build_object(
                        'waiting', count(*),
                        'overdue', count(*) filter (where sub.submitted_at < now() - interval '72 hours'))
                      from public.assignment_submissions sub where sub.branch_id = b.id and sub.status = 'submitted'),
        'leads', (select jsonb_build_object('new', count(*), 'won', count(*) filter (where c.stage = 'won'))
                   from public.crm_contacts c
                   where c.branch_id = b.id and c.erased_at is null and c.created_at >= v_from and c.created_at < v_to),
        'tasks', (select jsonb_build_object(
                     'open', count(*) filter (where t.status in ('open', 'in_progress', 'submitted')),
                     'overdue', count(*) filter (where t.status in ('open', 'in_progress') and t.due_at < now()),
                     'done', count(*) filter (where t.status = 'done' and t.completed_at >= v_from and t.completed_at < v_to))
                   from public.staff_tasks t where t.branch_id = b.id),
        'announcements', (select jsonb_build_object(
                             'published', count(distinct a.id),
                             'ackRequested', count(r.profile_id) filter (where a.requires_ack),
                             'acknowledged', count(r.acknowledged_at) filter (where a.requires_ack))
                           from public.announcements a left join public.announcement_recipients r on r.announcement_id = a.id
                           where a.branch_id = b.id and a.published_at >= v_from and a.published_at < v_to),
        'finance', case when app.has_permission(p_org, b.id, 'finance.read') then (
                     select coalesce(jsonb_object_agg(cur.currency, jsonb_build_object(
                       'received', (select coalesce(sum(p.amount), 0) from public.payments p
                                     where p.branch_id = b.id and p.currency = cur.currency and p.kind = 'payment'
                                       and (p.received_at at time zone v_tz)::date between p_from and p_to)::numeric(14, 2)::text,
                       'refunded', (select coalesce(sum(p.amount), 0) from public.payments p
                                     where p.branch_id = b.id and p.currency = cur.currency and p.kind = 'refund'
                                       and (p.received_at at time zone v_tz)::date between p_from and p_to)::numeric(14, 2)::text,
                       'outstanding', (select coalesce(sum(greatest(app.invoice_due(i.id) - app.invoice_paid(i.id), 0)), 0) from public.invoices i
                                        where i.branch_id = b.id and i.currency = cur.currency and i.status = 'issued')::numeric(14, 2)::text,
                       'overdue', (select coalesce(sum(greatest(app.invoice_due(i.id) - app.invoice_paid(i.id), 0)), 0) from public.invoices i
                                    where i.branch_id = b.id and i.currency = cur.currency and i.status = 'issued' and i.due_on < v_today)::numeric(14, 2)::text
                     )), '{}'::jsonb)
                     from (select distinct currency::text as currency from public.invoices where branch_id = b.id
                           union select distinct currency::text from public.payments where branch_id = b.id) cur)
                   end
      ) as row_data
      from public.branches b
      where b.organization_id = p_org and b.status = 'active' and app.has_permission(p_org, b.id, 'dashboard.read')
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
alter table public.staff_tasks             enable row level security;
alter table public.staff_task_events       enable row level security;
alter table public.announcements           enable row level security;
alter table public.announcement_recipients enable row level security;

create policy "assignee and task managers read tasks" on public.staff_tasks
  for select to authenticated using (assignee_id = (select auth.uid()) or app.has_permission(organization_id, branch_id, 'task.manage'));
create policy "assignee and task managers read task history" on public.staff_task_events
  for select to authenticated using (app.can_see_task(task_id));
create policy "recipients and publishers read announcements" on public.announcements
  for select to authenticated using (app.is_announcement_recipient(id) or app.has_permission(organization_id, branch_id, 'announcement.publish'));
create policy "own receipts and publishers read receipts" on public.announcement_recipients
  for select to authenticated using (profile_id = (select auth.uid()) or app.can_manage_announcement(announcement_id));

-- ---------------------------------------------------------------------------
-- 5. Привилегии: таблицы только читаются, изменения — функциями
-- ---------------------------------------------------------------------------
revoke all on public.staff_tasks, public.staff_task_events, public.announcements, public.announcement_recipients from anon, authenticated;
grant select on public.staff_tasks, public.staff_task_events, public.announcements, public.announcement_recipients to authenticated;
grant all on public.staff_tasks, public.staff_task_events, public.announcements, public.announcement_recipients to service_role;

revoke all on function public.task_create(uuid, jsonb, text, text, text, timestamptz), public.task_transition(uuid, text, text),
  public.task_comment(uuid, text), public.generate_task_reminders(timestamptz),
  public.announcement_publish(uuid, uuid, text, text, text[], boolean), public.announcement_read(uuid, boolean),
  public.announcement_archive(uuid), public.announcement_stats(uuid[]), public.branch_dashboard(uuid, date, date) from public, anon;
grant execute on function public.task_create(uuid, jsonb, text, text, text, timestamptz), public.task_transition(uuid, text, text),
  public.task_comment(uuid, text), public.announcement_publish(uuid, uuid, text, text, text[], boolean),
  public.announcement_read(uuid, boolean), public.announcement_archive(uuid), public.announcement_stats(uuid[]),
  public.branch_dashboard(uuid, date, date)
  to authenticated, service_role;
grant execute on function public.generate_task_reminders(timestamptz) to service_role;

grant execute on function app.can_see_task(uuid), app.is_announcement_recipient(uuid), app.can_manage_announcement(uuid),
  app.task_assignable(uuid, uuid, uuid) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
