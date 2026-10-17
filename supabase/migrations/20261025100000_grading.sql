-- =============================================================================
-- Блок B. Кабинет учителя: задания отдельным ученикам, офлайн-экзамены,
-- правила оценивания школы и итоги месяца (табель).
--
--  * assignment_students — если у задания есть строки, оно адресовано только этим
--    ученикам (видят, сдают и получают уведомление только они и их родители).
--    Создаётся функцией assignment_create (черновик → адресаты → публикация).
--  * group_exams / exam_results — экзамен, проведённый в классе: учитель вносит баллы
--    (или «не пришёл»). Ученик и родитель видят результат после публикации экзамена.
--    Онлайн-тест можно засчитать как экзамен (group_assessments.counts_as_exam).
--  * grading_policies — веса частей итога и шкала (директор, MFA). По умолчанию:
--    посещаемость 20, домашние 30, тесты 20, экзамены 30; пятибалльная шкала.
--  * report_cards — итог месяца по ученику и группе. Черновик считает БД
--    (report_cards_generate; в начале месяца — автоматически за прошлый месяц),
--    учитель проверяет, пишет комментарий и публикует. Опубликованный — неизменен.
--    Определения — SCHEMA.md §15.
-- =============================================================================

insert into public.permissions (code, description) values
  ('grading.manage', 'Задавать правила итоговой оценки школы');
insert into public.role_permissions (role, permission) values ('org_director', 'grading.manage');

insert into public.notification_kinds (code, optional, important) values
  ('exam_result', true, true), ('report_card', false, true), ('report_cards_ready', true, false);

-- ---------------------------------------------------------------------------
-- 1. Задания отдельным ученикам
-- ---------------------------------------------------------------------------
create table public.assignment_students (
  assignment_id   uuid not null references public.assignments (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  primary key (assignment_id, student_id)
);
create index assignment_students_student_idx on public.assignment_students (student_id);

-- Адресовано ли задание этому ученику: всей группе (нет адресатов) или ему лично.
create or replace function app.assignment_targets(p_assignment uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.assignment_students t where t.assignment_id = p_assignment)
      or exists (select 1 from public.assignment_students t where t.assignment_id = p_assignment and t.student_id = p_student);
$$;

-- Видит ли текущий ученик или родитель опубликованное задание группы.
create or replace function app.learner_sees_assignment(p_assignment uuid, p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (select 1 from public.assignment_students t where t.assignment_id = p_assignment)
      then app.is_group_student(p_group) or app.is_group_guardian(p_group)
    else exists (
      select 1 from public.assignment_students t
      where t.assignment_id = p_assignment
        and ((t.student_id = auth.uid() and app.is_group_student(p_group)) or app.is_guardian_of(t.student_id))
    )
  end;
$$;

drop policy "group members and supervisors can read assignments" on public.assignments;
create policy "group members and supervisors can read assignments" on public.assignments
  for select to authenticated using (
    app.is_group_teacher(group_id)
    or (status <> 'draft' and app.learner_sees_assignment(id, group_id))
    or app.has_permission(organization_id, branch_id, 'learning.read_all')
  );

-- Сдать можно только адресованное тебе задание.
create or replace function app.guard_individual_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.assignment_targets(new.assignment_id, new.student_id) then
    raise exception 'assignment is not available to this student' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger assignment_submissions_target_guard before insert on public.assignment_submissions
  for each row execute function app.guard_individual_submission();

-- Уведомление о задании — только адресатам (пересоздаём функцию этапа 11).
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
    for v_student in
      select e.student_id from public.enrollments e
      where e.group_id = new.group_id and e.status in ('pending', 'active') and app.assignment_targets(new.id, e.student_id)
    loop
      perform app.notify(new.organization_id, v_student, 'homework_assigned',
        jsonb_build_object('assignmentId', new.id, 'title', new.title, 'dueAt', new.due_at), 'homework-assigned:' || new.id || ':' || v_student);
    end loop;
  end if;
  return null;
end;
$$;

-- Задание группе или выбранным ученикам (p_students пустой — вся группа).
create or replace function public.assignment_create(
  p_group uuid, p_title text, p_instructions text, p_due_at timestamptz, p_max_score numeric, p_students uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g  public.groups%rowtype;
  v_id uuid;
  v_n  int;
begin
  select * into v_g from public.groups where id = p_group;
  if v_g.id is null or not app.is_group_teacher(p_group) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if cardinality(coalesce(p_students, '{}')) > 0 then
    select count(*) into v_n from public.enrollments e
     where e.group_id = p_group and e.status = 'active' and e.student_id = any (p_students);
    if v_n <> cardinality(array(select distinct unnest(p_students))) then
      raise exception 'students must be active in this group' using errcode = '23514';
    end if;
  end if;
  insert into public.assignments (organization_id, branch_id, group_id, title, instructions, due_at, max_score, status, created_by)
  values (v_g.organization_id, v_g.branch_id, p_group, btrim(coalesce(p_title, '')), nullif(btrim(p_instructions), ''), p_due_at, p_max_score, 'draft', auth.uid())
  returning id into v_id;
  insert into public.assignment_students (assignment_id, student_id, organization_id)
  select distinct v_id, s, v_g.organization_id from unnest(coalesce(p_students, '{}')) s;
  update public.assignments set status = 'published' where id = v_id; -- уведомления — уже с учётом адресатов
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Офлайн-экзамены
-- ---------------------------------------------------------------------------
create table public.group_exams (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  title           text not null check (length(btrim(title)) between 2 and 200),
  held_on         date not null,
  max_score       numeric(6, 2) not null check (max_score > 0),
  status          text not null default 'draft' check (status in ('draft', 'published')),
  created_by      uuid references public.profiles (id) on delete set null,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint group_exams_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete restrict,
  constraint group_exams_published_check check ((status = 'published') = (published_at is not null))
);
create index group_exams_group_idx on public.group_exams (group_id, held_on);

create table public.exam_results (
  exam_id         uuid not null references public.group_exams (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  score           numeric(6, 2) check (score >= 0),
  absent          boolean not null default false,
  comment         text check (length(comment) <= 1000),
  entered_by      uuid references public.profiles (id) on delete set null,
  entered_at      timestamptz not null default now(),
  primary key (exam_id, student_id),
  constraint exam_results_absent_check check (not (absent and score is not null))
);

create trigger group_exams_set_updated_at before update on public.group_exams
  for each row execute function app.set_updated_at();
create trigger group_exams_immutable before update on public.group_exams
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'group_id');

-- Публикация — один раз; после неё нельзя менять максимум и снимать с публикации.
create or replace function app.guard_exam()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'published exam cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status = 'published' and (new.status <> 'published' or new.max_score <> old.max_score) then
    raise exception 'published exam cannot be changed' using errcode = '42501';
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status = 'draft') then
    new.published_at := now();
  end if;
  return new;
end;
$$;
create trigger group_exams_guard before insert or update or delete on public.group_exams
  for each row execute function app.guard_exam();

-- Баллы: не больше максимума; только ученикам группы; вносит учитель (фиксируется кто и когда).
create or replace function app.guard_exam_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e public.group_exams%rowtype;
begin
  select * into v_e from public.group_exams where id = new.exam_id;
  if tg_op = 'UPDATE' and (new.exam_id <> old.exam_id or new.student_id <> old.student_id) then
    raise exception 'exam result owner is immutable' using errcode = '42501';
  end if;
  if new.score is not null and new.score > v_e.max_score then
    raise exception 'score exceeds max_score (%)', v_e.max_score using errcode = '23514';
  end if;
  if not exists (select 1 from public.enrollments e where e.group_id = v_e.group_id and e.student_id = new.student_id and e.status in ('active', 'completed')) then
    raise exception 'student is not in this group' using errcode = '23514';
  end if;
  new.organization_id := v_e.organization_id;
  new.entered_by := coalesce(auth.uid(), new.entered_by);
  new.entered_at := now();
  return new;
end;
$$;
create trigger exam_results_guard before insert or update on public.exam_results
  for each row execute function app.guard_exam_result();
-- Исправление балла — в журнал аудита: какой экзамен, какой ученик, было → стало.
create or replace function app.audit_exam_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.score, new.absent) is distinct from (old.score, old.absent) then
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity, entity_id, diff)
    select e.organization_id, e.branch_id, auth.uid(), 'update', 'exam_results', new.exam_id,
           jsonb_build_object('student_id', new.student_id,
                              'score', jsonb_build_object('old', old.score, 'new', new.score),
                              'absent', jsonb_build_object('old', old.absent, 'new', new.absent))
    from public.group_exams e where e.id = new.exam_id;
  end if;
  return null;
end;
$$;
create trigger exam_results_audit after update of score, absent on public.exam_results
  for each row execute function app.audit_exam_result();

-- Экзамен опубликован → ученикам и родителям (у кого есть результат).
create or replace function app.notify_exam_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.exam_results%rowtype;
  v_p uuid;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    for v_r in select * from public.exam_results where exam_id = new.id loop
      for v_p in select v_r.student_id union select app.guardians_of(new.organization_id, v_r.student_id) loop
        perform app.notify(new.organization_id, v_p, 'exam_result',
          jsonb_build_object('examId', new.id, 'title', new.title, 'score', v_r.score, 'maxScore', new.max_score, 'absent', v_r.absent),
          'exam-result:' || new.id || ':' || v_r.student_id);
      end loop;
    end loop;
  end if;
  return null;
end;
$$;
create trigger group_exams_notify after insert or update of status on public.group_exams
  for each row execute function app.notify_exam_published();

alter table public.group_assessments add column counts_as_exam boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Правила оценивания школы
-- ---------------------------------------------------------------------------
create table public.grading_policies (
  organization_id     uuid primary key references public.organizations (id) on delete restrict,
  weight_attendance   int not null check (weight_attendance between 0 and 100),
  weight_homework     int not null check (weight_homework between 0 and 100),
  weight_tests        int not null check (weight_tests between 0 and 100),
  weight_exam         int not null check (weight_exam between 0 and 100),
  scale               text not null default 'five' check (scale in ('five', 'percent')),
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now(),
  constraint grading_policies_sum_check check (weight_attendance + weight_homework + weight_tests + weight_exam = 100)
);
create trigger grading_policies_set_updated_at before update on public.grading_policies
  for each row execute function app.set_updated_at();

create or replace function app.grading_policy(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('attendance', weight_attendance, 'homework', weight_homework, 'tests', weight_tests, 'exam', weight_exam, 'scale', scale)
       from public.grading_policies where organization_id = p_org),
    jsonb_build_object('attendance', 20, 'homework', 30, 'tests', 20, 'exam', 30, 'scale', 'five')
  );
$$;

-- Пятибалльная шкала: 90+ → 5, 75+ → 4, 60+ → 3, иначе 2.
create or replace function app.five_point(p_pct numeric)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select case when p_pct is null then null when p_pct >= 90 then 5 when p_pct >= 75 then 4 when p_pct >= 60 then 3 else 2 end::smallint;
$$;

-- ---------------------------------------------------------------------------
-- 4. Итоги месяца
-- ---------------------------------------------------------------------------
create table public.report_cards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  month           date not null check (extract(day from month) = 1),
  attendance_pct  numeric(5, 2) check (attendance_pct between 0 and 100),
  homework_pct    numeric(5, 2) check (homework_pct between 0 and 100),
  tests_pct       numeric(5, 2) check (tests_pct between 0 and 100),
  exam_pct        numeric(5, 2) check (exam_pct between 0 and 100),
  final_pct       numeric(5, 2) check (final_pct between 0 and 100),
  grade           smallint check (grade between 2 and 5),
  details         jsonb not null default '{}'::jsonb,
  weights         jsonb not null,
  teacher_comment text check (length(teacher_comment) <= 2000),
  status          text not null default 'draft' check (status in ('draft', 'published')),
  computed_at     timestamptz not null default now(),
  published_at    timestamptz,
  published_by    uuid references public.profiles (id) on delete set null,
  constraint report_cards_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete restrict,
  constraint report_cards_unique_key unique (group_id, student_id, month),
  constraint report_cards_published_check check ((status = 'published') = (published_at is not null))
);
create index report_cards_student_idx on public.report_cards (student_id, month desc);

create or replace function app.guard_report_card()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.status = 'published' then
    raise exception 'published report card is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger report_cards_guard before update or delete on public.report_cards
  for each row execute function app.guard_report_card();

-- Части итога одного ученика за месяц (проценты 0–100; null — нет данных за месяц).
create or replace function app.compute_report(p_group uuid, p_student uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_g      public.groups%rowtype;
  v_tz     text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_w      jsonb;
  r        jsonb := '{}'::jsonb;
  v_att    numeric; v_att_n int; v_att_p int;
  v_hw     numeric; v_hw_n int;
  v_tests  numeric; v_tests_n int;
  v_exam   numeric; v_exam_n int;
  v_final  numeric;
  v_wsum   numeric := 0;
  v_acc    numeric := 0;
begin
  select * into v_g from public.groups where id = p_group;
  v_tz := coalesce(app.org_timezone(v_g.organization_id), 'Asia/Bishkek');
  v_from := p_month::timestamp at time zone v_tz;
  v_to := (p_month + interval '1 month')::timestamp at time zone v_tz;
  v_w := app.grading_policy(v_g.organization_id);

  -- Посещаемость: присутствовал / опоздал / ушёл раньше ÷ все отметки, кроме уважительной причины.
  select count(*) filter (where ar.status <> 'excused'), count(*) filter (where ar.status in ('present', 'late', 'left_early'))
    into v_att_n, v_att_p
  from public.attendance_records ar join public.lesson_sessions s on s.id = ar.session_id
  where s.group_id = p_group and ar.student_id = p_student and lower(s.period) >= v_from and lower(s.period) < v_to;
  v_att := case when v_att_n > 0 then round(100.0 * v_att_p / v_att_n, 2) end;

  -- Домашние: срок (или дата выдачи) в месяце; проверенная — балл, не сданная после срока — 0,
  -- сданная и не проверенная — не учитывается.
  select round(avg(x.pct), 2), count(x.pct) into v_hw, v_hw_n
  from (
    select case
             when sub.status = 'graded' then least(100, 100.0 * sub.score / a.max_score)
             when sub.id is null and a.due_at < now() then 0
           end as pct
    from public.assignments a
    left join public.assignment_submissions sub on sub.assignment_id = a.id and sub.student_id = p_student
    where a.group_id = p_group and a.status in ('published', 'closed')
      and coalesce(a.due_at, a.created_at) >= v_from and coalesce(a.due_at, a.created_at) < v_to
      and app.assignment_targets(a.id, p_student)
  ) x;

  -- Тесты (онлайн): лучшая попытка; без попытки после срока — 0; без попытки до срока — не учитывается.
  select round(avg(x.pct), 2), count(x.pct) into v_tests, v_tests_n
  from (
    select coalesce(
             (select max(100.0 * at.score / at.max_score) from public.assessment_attempts at
               where at.assessment_id = ga.assessment_id and at.student_id = p_student),
             case when ga.due_at < now() then 0 end) as pct
    from public.group_assessments ga
    where ga.group_id = p_group and not ga.counts_as_exam
      and coalesce(ga.due_at, ga.opens_at) >= v_from and coalesce(ga.due_at, ga.opens_at) < v_to
  ) x;

  -- Экзамены: опубликованные офлайн-экзамены месяца (не пришёл — 0, балл не внесён — не учитывается)
  -- и онлайн-тесты, засчитанные как экзамен.
  select round(avg(x.pct), 2), count(x.pct) into v_exam, v_exam_n
  from (
    select case when er.absent then 0 when er.score is not null then 100.0 * er.score / e.max_score end as pct
    from public.group_exams e
    join public.exam_results er on er.exam_id = e.id and er.student_id = p_student
    where e.group_id = p_group and e.status = 'published'
      and e.held_on >= p_month and e.held_on < (p_month + interval '1 month')::date
    union all
    select coalesce(
             (select max(100.0 * at.score / at.max_score) from public.assessment_attempts at
               where at.assessment_id = ga.assessment_id and at.student_id = p_student),
             case when ga.due_at < now() then 0 end)
    from public.group_assessments ga
    where ga.group_id = p_group and ga.counts_as_exam
      and coalesce(ga.due_at, ga.opens_at) >= v_from and coalesce(ga.due_at, ga.opens_at) < v_to
  ) x;

  -- Итог: взвешенное среднее по частям, где есть данные (веса остальных перераспределяются).
  if v_att is not null and (v_w ->> 'attendance')::int > 0 then v_wsum := v_wsum + (v_w ->> 'attendance')::int; v_acc := v_acc + v_att * (v_w ->> 'attendance')::int; end if;
  if v_hw is not null and (v_w ->> 'homework')::int > 0 then v_wsum := v_wsum + (v_w ->> 'homework')::int; v_acc := v_acc + v_hw * (v_w ->> 'homework')::int; end if;
  if v_tests is not null and (v_w ->> 'tests')::int > 0 then v_wsum := v_wsum + (v_w ->> 'tests')::int; v_acc := v_acc + v_tests * (v_w ->> 'tests')::int; end if;
  if v_exam is not null and (v_w ->> 'exam')::int > 0 then v_wsum := v_wsum + (v_w ->> 'exam')::int; v_acc := v_acc + v_exam * (v_w ->> 'exam')::int; end if;
  v_final := case when v_wsum > 0 then round(v_acc / v_wsum, 2) end;

  return jsonb_build_object(
    'attendance', v_att, 'homework', v_hw, 'tests', v_tests, 'exam', v_exam, 'final', v_final,
    'grade', case when v_w ->> 'scale' = 'five' then app.five_point(v_final) end,
    'weights', v_w,
    'details', jsonb_build_object('attendanceMarked', v_att_n, 'attendancePresent', v_att_p, 'homeworkCounted', v_hw_n,
                                  'testsCounted', v_tests_n, 'examsCounted', v_exam_n));
end;
$$;

create or replace function app.can_grade_group(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_group_teacher(p_group) or exists (
    select 1 from public.groups g where g.id = p_group and app.has_permission(g.organization_id, g.branch_id, 'group.manage'));
$$;

-- Пересчитать черновики табеля группы за месяц (опубликованные не трогаются; комментарий сохраняется).
create or replace function public.report_cards_generate(p_group uuid, p_month date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g  public.groups%rowtype;
  v_st uuid;
  v_r  jsonb;
  v_n  int := 0;
begin
  select * into v_g from public.groups where id = p_group;
  if v_g.id is null or (auth.uid() is not null and not app.can_grade_group(p_group)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1 or p_month > current_date then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  for v_st in select distinct e.student_id from public.enrollments e where e.group_id = p_group and e.status in ('active', 'completed') loop
    v_r := app.compute_report(p_group, v_st, p_month);
    insert into public.report_cards (organization_id, branch_id, group_id, student_id, month, attendance_pct, homework_pct, tests_pct, exam_pct,
                                     final_pct, grade, details, weights, computed_at)
    values (v_g.organization_id, v_g.branch_id, p_group, v_st, p_month, (v_r ->> 'attendance')::numeric, (v_r ->> 'homework')::numeric,
            (v_r ->> 'tests')::numeric, (v_r ->> 'exam')::numeric, (v_r ->> 'final')::numeric, (v_r ->> 'grade')::smallint,
            v_r -> 'details', v_r -> 'weights', now())
    on conflict (group_id, student_id, month) do update
      set attendance_pct = excluded.attendance_pct, homework_pct = excluded.homework_pct, tests_pct = excluded.tests_pct,
          exam_pct = excluded.exam_pct, final_pct = excluded.final_pct, grade = excluded.grade, details = excluded.details,
          weights = excluded.weights, computed_at = excluded.computed_at
      where public.report_cards.status = 'draft';
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.report_card_comment(p_id uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.report_cards%rowtype;
begin
  select * into v from public.report_cards where id = p_id;
  if v.id is null or not app.can_grade_group(v.group_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.report_cards set teacher_comment = nullif(btrim(coalesce(p_comment, '')), '') where id = p_id;
end;
$$;

-- Опубликовать черновики группы за месяц: ученик и родители получают уведомление.
create or replace function public.report_cards_publish(p_group uuid, p_month date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card public.report_cards%rowtype;
  v_p    uuid;
  v_n    int := 0;
begin
  if not app.can_grade_group(p_group) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for v_card in select * from public.report_cards where group_id = p_group and month = p_month and status = 'draft' for update loop
    update public.report_cards set status = 'published', published_at = now(), published_by = auth.uid() where id = v_card.id;
    for v_p in select v_card.student_id union select app.guardians_of(v_card.organization_id, v_card.student_id) loop
      perform app.notify(v_card.organization_id, v_p, 'report_card',
        jsonb_build_object('reportId', v_card.id, 'month', to_char(v_card.month, 'YYYY-MM'), 'final', v_card.final_pct, 'grade', v_card.grade),
        'report-card:' || v_card.id);
    end loop;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- В начале месяца (1–3 число по времени школы): черновики за прошлый месяц (если были занятия) и уведомление учителям.
create or replace function public.generate_monthly_reports(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g     public.groups%rowtype;
  v_local date;
  v_month date;
  v_n     int := 0;
  v_t     uuid;
begin
  for v_g in select g.* from public.groups g join public.organizations o on o.id = g.organization_id
              where g.status in ('planned', 'active', 'completed') and o.status = 'active' loop
    v_local := (p_now at time zone coalesce(app.org_timezone(v_g.organization_id), 'Asia/Bishkek'))::date;
    continue when extract(day from v_local) > 3;
    v_month := (date_trunc('month', v_local) - interval '1 month')::date;
    -- Табель — только за месяц, в котором у группы были занятия.
    continue when not exists (
      select 1 from public.lesson_sessions s
      where s.group_id = v_g.id and s.status <> 'cancelled'
        and lower(s.period) >= v_month::timestamp at time zone coalesce(app.org_timezone(v_g.organization_id), 'Asia/Bishkek')
        and lower(s.period) < (v_month + interval '1 month')::timestamp at time zone coalesce(app.org_timezone(v_g.organization_id), 'Asia/Bishkek'));
    perform public.report_cards_generate(v_g.id, v_month);
    for v_t in select teacher_id from public.group_teachers where group_id = v_g.id loop
      perform app.notify(v_g.organization_id, v_t, 'report_cards_ready',
        jsonb_build_object('groupId', v_g.id, 'groupName', v_g.name, 'month', to_char(v_month, 'YYYY-MM')),
        'report-ready:' || v_g.id || ':' || to_char(v_month, 'YYYY-MM'));
    end loop;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('groups', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
alter table public.assignment_students enable row level security;
alter table public.group_exams         enable row level security;
alter table public.exam_results        enable row level security;
alter table public.grading_policies    enable row level security;
alter table public.report_cards        enable row level security;

create policy "teachers, targeted learners and supervisors read targets" on public.assignment_students
  for select to authenticated using (
    student_id = (select auth.uid()) or app.is_guardian_of(student_id)
    or exists (select 1 from public.assignments a where a.id = assignment_id
               and (app.is_group_teacher(a.group_id) or app.has_permission(a.organization_id, a.branch_id, 'learning.read_all')))
  );

create policy "group members read exams" on public.group_exams
  for select to authenticated using (
    app.is_group_teacher(group_id) or app.has_permission(organization_id, branch_id, 'learning.read_all')
    or (status = 'published' and (app.is_group_student(group_id) or app.is_group_guardian(group_id)))
  );
create policy "group teachers create exams" on public.group_exams
  for insert to authenticated with check (app.is_group_teacher(group_id) and created_by = (select auth.uid()));
create policy "group teachers update exams" on public.group_exams
  for update to authenticated using (app.is_group_teacher(group_id)) with check (app.is_group_teacher(group_id));
create policy "group teachers delete draft exams" on public.group_exams
  for delete to authenticated using (app.is_group_teacher(group_id) and status = 'draft');

create or replace function app.exam_access(p_exam uuid, p_student uuid, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_exams e
    where e.id = p_exam and (
      app.is_group_teacher(e.group_id)
      or (not p_write and (
            app.has_permission(e.organization_id, e.branch_id, 'learning.read_all')
            or (e.status = 'published' and (p_student = auth.uid() or app.is_guardian_of(p_student)))))
    )
  );
$$;

create policy "teachers, the student and guardians read results" on public.exam_results
  for select to authenticated using (app.exam_access(exam_id, student_id, false));
create policy "group teachers enter results" on public.exam_results
  for insert to authenticated with check (app.exam_access(exam_id, student_id, true));
create policy "group teachers correct results" on public.exam_results
  for update to authenticated using (app.exam_access(exam_id, student_id, true)) with check (app.exam_access(exam_id, student_id, true));

create policy "members read grading policy" on public.grading_policies
  for select to authenticated using (app.is_member(organization_id));
create policy "directors with mfa set grading policy" on public.grading_policies
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'grading.manage'));
create policy "directors with mfa change grading policy" on public.grading_policies
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'grading.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'grading.manage'));

create policy "teachers, supervisors, the student and guardians read report cards" on public.report_cards
  for select to authenticated using (
    app.is_group_teacher(group_id) or app.has_permission(organization_id, branch_id, 'learning.read_all')
    or (status = 'published' and (student_id = (select auth.uid()) or app.is_guardian_of(student_id)))
  );

-- ---------------------------------------------------------------------------
-- 6. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.assignment_students, public.group_exams, public.exam_results, public.grading_policies, public.report_cards from anon, authenticated;
grant select on public.assignment_students, public.report_cards to authenticated;
grant select, insert, delete on public.group_exams to authenticated;
grant update (title, held_on, max_score, status) on public.group_exams to authenticated;
grant select, insert on public.exam_results to authenticated;
-- Ключевые столбцы в списке ради upsert; менять их запрещает триггер (а организацию он подставляет сам).
grant update (exam_id, student_id, organization_id, score, absent, comment) on public.exam_results to authenticated;
grant select, insert on public.grading_policies to authenticated;
grant update (weight_attendance, weight_homework, weight_tests, weight_exam, scale, updated_by) on public.grading_policies to authenticated;
grant update (counts_as_exam) on public.group_assessments to authenticated;
grant all on public.assignment_students, public.group_exams, public.exam_results, public.grading_policies, public.report_cards to service_role;

revoke all on function public.assignment_create(uuid, text, text, timestamptz, numeric, uuid[]), public.report_cards_generate(uuid, date),
  public.report_card_comment(uuid, text), public.report_cards_publish(uuid, date), public.generate_monthly_reports(timestamptz) from public, anon;
grant execute on function public.assignment_create(uuid, text, text, timestamptz, numeric, uuid[]), public.report_cards_generate(uuid, date),
  public.report_card_comment(uuid, text), public.report_cards_publish(uuid, date) to authenticated, service_role;
grant execute on function public.generate_monthly_reports(timestamptz) to service_role;

grant execute on function app.assignment_targets(uuid, uuid), app.learner_sees_assignment(uuid, uuid), app.exam_access(uuid, uuid, boolean),
  app.can_grade_group(uuid) to authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
