-- ============================================================================
-- 0004 · Домашние задания и работы учеников (минимум для этапа 2;
--        материалы, тесты и прогресс — этап 5).
-- ============================================================================

create table public.assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  title           text not null check (length(btrim(title)) between 2 and 200),
  instructions    text check (length(instructions) <= 20000),
  due_at          timestamptz,
  max_score       numeric(6, 2) not null default 100 check (max_score > 0),
  status          text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint assignments_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete restrict,
  constraint assignments_scope_id_key unique (organization_id, branch_id, id)
);
create index assignments_group_idx on public.assignments (group_id);

create table public.assignment_submissions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  assignment_id   uuid not null,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  body            text not null check (length(body) between 1 and 50000),
  status          text not null default 'submitted' check (status in ('submitted', 'returned', 'graded')),
  score           numeric(6, 2) check (score >= 0),
  feedback        text check (length(feedback) <= 20000),
  submitted_at    timestamptz not null default now(),
  graded_at       timestamptz,
  graded_by       uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint assignment_submissions_assignment_fkey foreign key (organization_id, branch_id, assignment_id)
    references public.assignments (organization_id, branch_id, id) on delete restrict,
  -- Одна работа на ученика и задание: повторная отправка обновляет её, а не создаёт дубль.
  constraint assignment_submissions_unique_key unique (assignment_id, student_id),
  constraint assignment_submissions_grade_check check ((status = 'graded') = (score is not null))
);
create index assignment_submissions_student_idx on public.assignment_submissions (student_id);

-- Ученик меняет только текст работы (пока не оценена); преподаватель — только оценку.
create or replace function app.guard_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group     uuid;
  v_max_score numeric;
  v_status    text;
  v_is_grader boolean;
begin
  select a.group_id, a.max_score, a.status into v_group, v_max_score, v_status
  from public.assignments a where a.id = new.assignment_id;

  if new.score is not null and new.score > v_max_score then
    raise exception 'score exceeds max_score (%)', v_max_score using errcode = '23514';
  end if;

  -- Служебные операции (service role, миграции) — без пользовательского контекста.
  if auth.uid() is null then
    return new;
  end if;

  v_is_grader := app.is_group_teacher(v_group);

  if tg_op = 'INSERT' then
    if new.student_id <> auth.uid() then
      raise exception 'students can only submit their own work' using errcode = '42501';
    end if;
    if not app.is_group_student(v_group) or v_status <> 'published' then
      raise exception 'assignment is not available to this student' using errcode = '42501';
    end if;
    if new.status <> 'submitted' or new.score is not null or new.graded_at is not null or new.graded_by is not null then
      raise exception 'students cannot grade their own work' using errcode = '42501';
    end if;
    return new;
  end if;

  if v_is_grader then
    if new.body is distinct from old.body or new.submitted_at is distinct from old.submitted_at then
      raise exception 'teachers cannot change the submitted work' using errcode = '42501';
    end if;
    if new.status = 'graded' and (old.status <> 'graded' or new.score is distinct from old.score) then
      new.graded_at := now();
      new.graded_by := auth.uid();
    end if;
    return new;
  end if;

  if new.student_id = auth.uid() then
    if old.status = 'graded' then
      raise exception 'graded work cannot be changed' using errcode = '42501';
    end if;
    if new.score is distinct from old.score or new.feedback is distinct from old.feedback
       or new.graded_at is distinct from old.graded_at or new.graded_by is distinct from old.graded_by then
      raise exception 'students cannot grade their own work' using errcode = '42501';
    end if;
    if v_status <> 'published' then
      raise exception 'assignment is closed' using errcode = '42501';
    end if;
    new.status := 'submitted';
    new.submitted_at := now();
    return new;
  end if;

  raise exception 'not allowed to change this submission' using errcode = '42501';
end;
$$;

create trigger assignments_set_updated_at before update on public.assignments
  for each row execute function app.set_updated_at();
create trigger assignments_immutable before update on public.assignments
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'group_id');

create trigger assignment_submissions_set_updated_at before update on public.assignment_submissions
  for each row execute function app.set_updated_at();
create trigger assignment_submissions_immutable before update on public.assignment_submissions
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'assignment_id', 'student_id');
create trigger assignment_submissions_guard before insert or update on public.assignment_submissions
  for each row execute function app.guard_submission();
create trigger assignment_submissions_audit after update of score, status on public.assignment_submissions
  for each row execute function app.audit_row();

alter table public.assignments            enable row level security;
alter table public.assignment_submissions enable row level security;

-- Задания: видят участники группы и руководство с learning.read_all; создаёт преподаватель группы.
create policy "group members and supervisors can read assignments" on public.assignments
  for select to authenticated using (
    app.is_group_teacher(group_id)
    or (status <> 'draft' and (app.is_group_student(group_id) or app.is_group_guardian(group_id)))
    or app.has_permission(organization_id, branch_id, 'learning.read_all')
  );
create policy "group teachers can create assignments" on public.assignments
  for insert to authenticated with check (app.is_group_teacher(group_id) and created_by = (select auth.uid()));
create policy "group teachers can update assignments" on public.assignments
  for update to authenticated using (app.is_group_teacher(group_id)) with check (app.is_group_teacher(group_id));

-- Работы: автор, его опекун, преподаватель группы, руководство в охвате.
create policy "authors, guardians, teachers and supervisors can read submissions" on public.assignment_submissions
  for select to authenticated using (
    student_id = (select auth.uid())
    or app.is_guardian_of(student_id)
    or exists (select 1 from public.assignments a where a.id = assignment_id and app.is_group_teacher(a.group_id))
    or app.has_permission(organization_id, branch_id, 'learning.read_all')
  );
create policy "enrolled students can submit own work" on public.assignment_submissions
  for insert to authenticated with check (student_id = (select auth.uid()));
create policy "authors and group teachers can update submissions" on public.assignment_submissions
  for update to authenticated
  using (
    student_id = (select auth.uid())
    or exists (select 1 from public.assignments a where a.id = assignment_id and app.is_group_teacher(a.group_id))
  )
  with check (
    student_id = (select auth.uid())
    or exists (select 1 from public.assignments a where a.id = assignment_id and app.is_group_teacher(a.group_id))
  );

revoke all on public.assignments, public.assignment_submissions from anon, authenticated;
grant select, insert, update on public.assignments, public.assignment_submissions to authenticated;
grant all on public.assignments, public.assignment_submissions to service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
