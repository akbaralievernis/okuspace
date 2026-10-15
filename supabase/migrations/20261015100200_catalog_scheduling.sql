-- ============================================================================
-- 0003 · Каталог, группы, записи, аудитории, занятия + видимость профилей.
-- Модель: docs/architecture/DATA_MODEL.md §3.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Каталог (уровень организации)
-- ---------------------------------------------------------------------------
create table public.languages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  code            text not null check (code ~ '^[a-z]{2,3}$'),
  name            text not null check (length(btrim(name)) between 2 and 100),
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint languages_org_code_key unique (organization_id, code),
  constraint languages_org_id_key unique (organization_id, id)
);

create table public.course_levels (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  language_id     uuid not null,
  code            text not null check (code ~ '^[A-Za-z0-9.+-]{1,16}$'),
  title           text not null check (length(btrim(title)) between 1 and 100),
  framework       text not null default 'cefr' check (framework in ('cefr', 'custom')),
  sort_order      int not null check (sort_order between 0 and 1000),
  created_at      timestamptz not null default now(),
  constraint course_levels_language_fkey foreign key (organization_id, language_id)
    references public.languages (organization_id, id) on delete restrict,
  constraint course_levels_code_key unique (organization_id, language_id, code),
  constraint course_levels_id_key unique (organization_id, language_id, id),
  constraint course_levels_cefr_check
    check (framework <> 'cefr' or code in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'))
);

create table public.courses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  language_id      uuid not null,
  level_id         uuid not null,
  title            text not null check (length(btrim(title)) between 2 and 200),
  description      text check (length(description) <= 5000),
  format           text not null check (format in ('online', 'offline', 'hybrid')),
  kind             text not null check (kind in ('group', 'individual')),
  duration_weeks   int not null check (duration_weeks between 1 and 260),
  lessons_per_week int not null default 2 check (lessons_per_week between 1 and 14),
  status           text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint courses_language_fkey foreign key (organization_id, language_id)
    references public.languages (organization_id, id) on delete restrict,
  -- Уровень обязан принадлежать тому же языку и той же организации.
  constraint courses_level_fkey foreign key (organization_id, language_id, level_id)
    references public.course_levels (organization_id, language_id, id) on delete restrict,
  constraint courses_org_id_key unique (organization_id, id)
);

-- ---------------------------------------------------------------------------
-- Аудитории и группы (уровень филиала)
-- ---------------------------------------------------------------------------
create table public.classrooms (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 100),
  capacity        int not null check (capacity between 1 and 500),
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint classrooms_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint classrooms_branch_name_key unique (branch_id, name),
  constraint classrooms_scope_id_key unique (organization_id, branch_id, id)
);

create table public.groups (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  branch_id         uuid not null,
  course_id         uuid not null,
  name              text not null check (length(btrim(name)) between 1 and 100),
  capacity          int not null check (capacity between 1 and 500),
  enrollment_status text not null default 'open' check (enrollment_status in ('open', 'closed', 'waitlist')),
  status            text not null default 'planned' check (status in ('planned', 'active', 'completed', 'cancelled')),
  starts_on         date not null,
  ends_on           date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint groups_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint groups_course_fkey foreign key (organization_id, course_id)
    references public.courses (organization_id, id) on delete restrict,
  constraint groups_dates_check check (ends_on is null or ends_on >= starts_on),
  constraint groups_branch_name_key unique (branch_id, name),
  constraint groups_scope_id_key unique (organization_id, branch_id, id)
);

create table public.group_teachers (
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  teacher_id      uuid not null references public.profiles (id) on delete restrict,
  role            text not null default 'primary' check (role in ('primary', 'assistant')),
  created_at      timestamptz not null default now(),
  primary key (group_id, teacher_id),
  constraint group_teachers_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete cascade
);
create index group_teachers_teacher_idx on public.group_teachers (teacher_id);

create table public.enrollments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  status          text not null default 'pending'
    check (status in ('pending', 'active', 'paused', 'completed', 'cancelled')),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint enrollments_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete restrict
);
-- Повторная запись в ту же группу невозможна (кроме отменённых).
create unique index enrollments_group_student_idx on public.enrollments (group_id, student_id)
  where status <> 'cancelled';
create index enrollments_student_idx on public.enrollments (student_id);

-- ---------------------------------------------------------------------------
-- Занятия. EXCLUDE-ограничения запрещают двойное бронирование преподавателя
-- и аудитории (отменённые занятия не учитываются).
-- ---------------------------------------------------------------------------
create table public.lesson_sessions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  teacher_id      uuid not null references public.profiles (id) on delete restrict,
  classroom_id    uuid,
  period          tstzrange not null,
  status          text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  online_url      text check (online_url ~ '^https://'),
  moved_from_id   uuid references public.lesson_sessions (id) on delete restrict,
  cancel_reason   text check (length(cancel_reason) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint lesson_sessions_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete restrict,
  constraint lesson_sessions_classroom_fkey foreign key (organization_id, branch_id, classroom_id)
    references public.classrooms (organization_id, branch_id, id) on delete restrict,
  constraint lesson_sessions_period_check check (
    not isempty(period) and lower_inc(period) and not upper_inc(period)
    and not lower_inf(period) and not upper_inf(period)
    and upper(period) - lower(period) <= interval '8 hours'
  ),
  constraint lesson_sessions_place_check check (classroom_id is not null or online_url is not null),
  constraint lesson_sessions_cancel_check check (status <> 'cancelled' or cancel_reason is not null),
  constraint lesson_sessions_teacher_excl exclude using gist (teacher_id with =, period with &&)
    where (status <> 'cancelled'),
  constraint lesson_sessions_classroom_excl exclude using gist (classroom_id with =, period with &&)
    where (status <> 'cancelled' and classroom_id is not null)
);
create index lesson_sessions_group_idx on public.lesson_sessions (group_id, lower(period));

-- ---------------------------------------------------------------------------
-- Функции связи «пользователь ↔ группа»
-- ---------------------------------------------------------------------------
create or replace function app.is_group_teacher(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_teachers gt
    join public.memberships m
      on m.organization_id = gt.organization_id and m.branch_id = gt.branch_id
     and m.profile_id = gt.teacher_id and m.role = 'teacher' and m.status = 'active'
    join public.organizations o on o.id = gt.organization_id and o.status = 'active'
    where gt.group_id = p_group and gt.teacher_id = (select auth.uid())
  );
$$;

create or replace function app.is_group_student(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.enrollments e
    join public.memberships m
      on m.organization_id = e.organization_id and m.branch_id = e.branch_id
     and m.profile_id = e.student_id and m.role = 'student' and m.status = 'active'
    join public.organizations o on o.id = e.organization_id and o.status = 'active'
    where e.group_id = p_group and e.student_id = (select auth.uid()) and e.status <> 'cancelled'
  );
$$;

create or replace function app.is_group_guardian(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.enrollments e
    where e.group_id = p_group and e.status <> 'cancelled' and app.is_guardian_of(e.student_id)
  );
$$;

create or replace function app.can_read_group(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group
      and (
        app.has_permission(g.organization_id, g.branch_id, 'group.read')
        or app.is_group_teacher(g.id)
        or app.is_group_student(g.id)
        or app.is_group_guardian(g.id)
      )
  );
$$;

-- Видимость чужого профиля: сотрудники в охвате, опекун, преподаватель ↔ ученик общей группы.
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
    -- я преподаю в группе, где учится p_profile
    or exists (
      select 1 from public.enrollments e
      where e.student_id = p_profile and e.status <> 'cancelled' and app.is_group_teacher(e.group_id)
    )
    -- p_profile преподаёт в группе, где учусь я или мой подопечный
    or exists (
      select 1 from public.group_teachers gt
      where gt.teacher_id = p_profile
        and (app.is_group_student(gt.group_id) or app.is_group_guardian(gt.group_id))
    );
$$;

grant execute on function app.is_group_teacher(uuid), app.is_group_student(uuid), app.is_group_guardian(uuid),
  app.can_read_group(uuid), app.can_see_profile(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Триггеры целостности
-- ---------------------------------------------------------------------------
create or replace function app.check_group_teacher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_active_role(new.organization_id, new.branch_id, new.teacher_id, 'teacher');
  return new;
end;
$$;

create or replace function app.check_enrollment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity int;
  v_taken    int;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status in ('pending', 'active') then
      perform app.assert_active_role(new.organization_id, new.branch_id, new.student_id, 'student');
    end if;
  end if;

  -- Вместимость считается для pending + active; блокировка строки группы сериализует записи.
  if new.status in ('pending', 'active') and (tg_op = 'INSERT' or old.status not in ('pending', 'active')) then
    select capacity into v_capacity from public.groups where id = new.group_id for update;
    select count(*) into v_taken from public.enrollments
      where group_id = new.group_id and status in ('pending', 'active') and id <> new.id;
    if v_taken >= v_capacity then
      raise exception 'group is full (capacity %)', v_capacity using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.check_lesson_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.group_teachers where group_id = new.group_id and teacher_id = new.teacher_id) then
    raise exception 'teacher is not assigned to this group' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger languages_set_updated_at before update on public.languages
  for each row execute function app.set_updated_at();
create trigger languages_immutable before update on public.languages
  for each row execute function app.forbid_column_change('organization_id');
create trigger courses_set_updated_at before update on public.courses
  for each row execute function app.set_updated_at();
create trigger courses_immutable before update on public.courses
  for each row execute function app.forbid_column_change('organization_id');
create trigger course_levels_immutable before update on public.course_levels
  for each row execute function app.forbid_column_change('organization_id', 'language_id');

create trigger classrooms_set_updated_at before update on public.classrooms
  for each row execute function app.set_updated_at();
create trigger classrooms_immutable before update on public.classrooms
  for each row execute function app.forbid_column_change('organization_id', 'branch_id');

create trigger groups_set_updated_at before update on public.groups
  for each row execute function app.set_updated_at();
create trigger groups_immutable before update on public.groups
  for each row execute function app.forbid_column_change('organization_id', 'branch_id');

create trigger group_teachers_check before insert or update on public.group_teachers
  for each row execute function app.check_group_teacher();
create trigger group_teachers_immutable before update on public.group_teachers
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'group_id', 'teacher_id');

create trigger enrollments_set_updated_at before update on public.enrollments
  for each row execute function app.set_updated_at();
create trigger enrollments_immutable before update on public.enrollments
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'group_id', 'student_id');
create trigger enrollments_check before insert or update on public.enrollments
  for each row execute function app.check_enrollment();
create trigger enrollments_audit after insert or update on public.enrollments
  for each row execute function app.audit_row();

create trigger lesson_sessions_set_updated_at before update on public.lesson_sessions
  for each row execute function app.set_updated_at();
create trigger lesson_sessions_immutable before update on public.lesson_sessions
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'group_id');
create trigger lesson_sessions_check before insert or update of teacher_id, group_id on public.lesson_sessions
  for each row execute function app.check_lesson_session();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.languages       enable row level security;
alter table public.course_levels   enable row level security;
alter table public.courses         enable row level security;
alter table public.classrooms      enable row level security;
alter table public.groups          enable row level security;
alter table public.group_teachers  enable row level security;
alter table public.enrollments     enable row level security;
alter table public.lesson_sessions enable row level security;

-- Профили: связанные пользователи (дополняет "users can read own profile").
create policy "related users can read profiles" on public.profiles
  for select to authenticated using (app.can_see_profile(id));

-- Каталог: читают участники организации; меняет catalog.manage уровня организации.
create policy "members can read languages" on public.languages
  for select to authenticated using (app.is_member(organization_id));
create policy "catalog managers can create languages" on public.languages
  for insert to authenticated with check (app.has_permission(organization_id, null, 'catalog.manage'));
create policy "catalog managers can update languages" on public.languages
  for update to authenticated
  using (app.has_permission(organization_id, null, 'catalog.manage'))
  with check (app.has_permission(organization_id, null, 'catalog.manage'));

create policy "members can read course levels" on public.course_levels
  for select to authenticated using (app.is_member(organization_id));
create policy "catalog managers can create course levels" on public.course_levels
  for insert to authenticated with check (app.has_permission(organization_id, null, 'catalog.manage'));
create policy "catalog managers can update course levels" on public.course_levels
  for update to authenticated
  using (app.has_permission(organization_id, null, 'catalog.manage'))
  with check (app.has_permission(organization_id, null, 'catalog.manage'));

create policy "members can read courses" on public.courses
  for select to authenticated using (app.is_member(organization_id));
create policy "catalog managers can create courses" on public.courses
  for insert to authenticated with check (app.has_permission(organization_id, null, 'catalog.manage'));
create policy "catalog managers can update courses" on public.courses
  for update to authenticated
  using (app.has_permission(organization_id, null, 'catalog.manage'))
  with check (app.has_permission(organization_id, null, 'catalog.manage'));

-- Аудитории
create policy "members can read classrooms" on public.classrooms
  for select to authenticated using (app.is_member(organization_id));
create policy "schedulers can create classrooms" on public.classrooms
  for insert to authenticated with check (app.has_permission(organization_id, branch_id, 'schedule.manage'));
create policy "schedulers can update classrooms" on public.classrooms
  for update to authenticated
  using (app.has_permission(organization_id, branch_id, 'schedule.manage'))
  with check (app.has_permission(organization_id, branch_id, 'schedule.manage'));

-- Группы
create policy "related users can read groups" on public.groups
  for select to authenticated using (app.can_read_group(id));
create policy "group managers can create groups" on public.groups
  for insert to authenticated with check (app.has_permission(organization_id, branch_id, 'group.manage'));
create policy "group managers can update groups" on public.groups
  for update to authenticated
  using (app.has_permission(organization_id, branch_id, 'group.manage'))
  with check (app.has_permission(organization_id, branch_id, 'group.manage'));

create policy "related users can read group teachers" on public.group_teachers
  for select to authenticated using (app.can_read_group(group_id));
create policy "group managers can assign teachers" on public.group_teachers
  for insert to authenticated with check (app.has_permission(organization_id, branch_id, 'group.manage'));
create policy "group managers can remove teachers" on public.group_teachers
  for delete to authenticated using (app.has_permission(organization_id, branch_id, 'group.manage'));

-- Записи на курс
create policy "related users can read enrollments" on public.enrollments
  for select to authenticated using (
    student_id = (select auth.uid())
    or app.is_guardian_of(student_id)
    or app.is_group_teacher(group_id)
    or app.has_permission(organization_id, branch_id, 'group.read')
  );
create policy "enrollment managers can enroll" on public.enrollments
  for insert to authenticated with check (
    app.has_permission(organization_id, branch_id, 'enrollment.manage') and created_by = (select auth.uid())
  );
create policy "enrollment managers can change enrollments" on public.enrollments
  for update to authenticated
  using (app.has_permission(organization_id, branch_id, 'enrollment.manage'))
  with check (app.has_permission(organization_id, branch_id, 'enrollment.manage'));

-- Занятия
create policy "related users can read lesson sessions" on public.lesson_sessions
  for select to authenticated using (app.can_read_group(group_id));
create policy "schedulers can create lesson sessions" on public.lesson_sessions
  for insert to authenticated with check (app.has_permission(organization_id, branch_id, 'schedule.manage'));
create policy "schedulers can update lesson sessions" on public.lesson_sessions
  for update to authenticated
  using (app.has_permission(organization_id, branch_id, 'schedule.manage'))
  with check (app.has_permission(organization_id, branch_id, 'schedule.manage'));

-- ---------------------------------------------------------------------------
-- Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.languages, public.course_levels, public.courses, public.classrooms, public.groups,
  public.group_teachers, public.enrollments, public.lesson_sessions from anon, authenticated;
grant select, insert, update on public.languages, public.course_levels, public.courses, public.classrooms,
  public.groups, public.enrollments, public.lesson_sessions to authenticated;
grant select, insert, delete on public.group_teachers to authenticated;
grant all on public.languages, public.course_levels, public.courses, public.classrooms, public.groups,
  public.group_teachers, public.enrollments, public.lesson_sessions to service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
