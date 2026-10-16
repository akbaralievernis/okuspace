-- ============================================================================
-- 0008 · LMS (этап 5): структура курса, материалы уроков, тесты с закрытыми
--        ключами ответов, проверка на сервере, идемпотентные попытки,
--        пересдачи, прогресс. Плюс каталог: расписание группы текстом.
-- Принципы:
--   * ученик видит только опубликованное в курсе, на который записан;
--   * ключи ответов — в отдельной таблице, ученику недоступны никогда;
--   * оценка вычисляется функцией БД, а не клиентом;
--   * правильные ответы раскрываются только по правилу теста.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Каталог: расписание группы человеческим текстом (полное расписание — этап 6)
-- ---------------------------------------------------------------------------
alter table public.groups add column schedule_note text check (length(schedule_note) <= 200);

-- ---------------------------------------------------------------------------
-- 1. Связь «пользователь ↔ курс»
-- ---------------------------------------------------------------------------
create or replace function app.is_course_student(p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.course_id = p_course and app.is_group_student(g.id)
  );
$$;

create or replace function app.is_course_teacher(p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    where g.course_id = p_course and g.status <> 'cancelled' and app.is_group_teacher(g.id)
  );
$$;

-- Редактировать содержание: преподаватель группы этого курса или методист (catalog.manage).
create or replace function app.can_edit_course(p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.courses c
    where c.id = p_course
      and (app.has_permission(c.organization_id, null, 'catalog.manage') or app.is_course_teacher(c.id))
  );
$$;

-- Читать содержание: редакторы, записанные ученики, их опекуны, руководство с learning.read_all.
create or replace function app.can_view_course(p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.can_edit_course(p_course)
      or app.is_course_student(p_course)
      or exists (select 1 from public.groups g where g.course_id = p_course and app.is_group_guardian(g.id))
      or exists (
        select 1 from public.groups g
        where g.course_id = p_course and app.has_permission(g.organization_id, g.branch_id, 'learning.read_all')
      );
$$;

-- ---------------------------------------------------------------------------
-- 2. Структура и материалы
-- ---------------------------------------------------------------------------
create table public.course_modules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  course_id       uuid not null,
  title           text not null check (length(btrim(title)) between 1 and 200),
  position        int not null check (position between 0 and 10000),
  status          text not null default 'draft' check (status in ('draft', 'published')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint course_modules_course_fkey foreign key (organization_id, course_id)
    references public.courses (organization_id, id) on delete restrict,
  constraint course_modules_scope_key unique (organization_id, course_id, id)
);
create index course_modules_course_idx on public.course_modules (course_id, position);

create table public.lessons (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  course_id         uuid not null,
  module_id         uuid not null,
  title             text not null check (length(btrim(title)) between 1 and 200),
  position          int not null check (position between 0 and 10000),
  estimated_minutes int check (estimated_minutes between 1 and 600),
  status            text not null default 'draft' check (status in ('draft', 'published')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint lessons_module_fkey foreign key (organization_id, course_id, module_id)
    references public.course_modules (organization_id, course_id, id) on delete restrict,
  constraint lessons_scope_key unique (organization_id, course_id, id)
);
create index lessons_module_idx on public.lessons (module_id, position);

-- Блоки урока. Содержимое — JSON с проверкой формы по типу (CHECK + триггер).
create table public.lesson_blocks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  course_id       uuid not null,
  lesson_id       uuid not null,
  position        int not null check (position between 0 and 10000),
  type            text not null check (type in ('text', 'video', 'audio', 'vocabulary', 'reading', 'listening', 'writing_prompt', 'speaking_prompt')),
  content         jsonb not null check (jsonb_typeof(content) = 'object' and length(content::text) <= 100000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint lesson_blocks_lesson_fkey foreign key (organization_id, course_id, lesson_id)
    references public.lessons (organization_id, course_id, id) on delete cascade
);
create index lesson_blocks_lesson_idx on public.lesson_blocks (lesson_id, position);

create or replace function app.validate_lesson_block()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c jsonb := new.content;
begin
  case new.type
    when 'text', 'reading', 'writing_prompt', 'speaking_prompt' then
      if jsonb_typeof(c -> 'body') is distinct from 'string' then
        raise exception 'block % requires a text body', new.type using errcode = '23514';
      end if;
    when 'video', 'audio', 'listening' then
      -- Медиа — только по https; список разрешённых хостов задаёт CSP приложения.
      if jsonb_typeof(c -> 'url') is distinct from 'string' or (c ->> 'url') !~ '^https://[^\s]+$' then
        raise exception 'block % requires an https url', new.type using errcode = '23514';
      end if;
    when 'vocabulary' then
      if jsonb_typeof(c -> 'items') is distinct from 'array' or jsonb_array_length(c -> 'items') = 0
         or exists (select 1 from jsonb_array_elements(c -> 'items') i
                    where jsonb_typeof(i -> 'term') is distinct from 'string' or jsonb_typeof(i -> 'meaning') is distinct from 'string') then
        raise exception 'vocabulary block requires items with term and meaning' using errcode = '23514';
      end if;
  end case;
  return new;
end;
$$;

create trigger lesson_blocks_validate before insert or update on public.lesson_blocks
  for each row execute function app.validate_lesson_block();

-- ---------------------------------------------------------------------------
-- 3. Тесты и упражнения
-- ---------------------------------------------------------------------------
create table public.assessments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  course_id       uuid not null,
  lesson_id       uuid,
  title           text not null check (length(btrim(title)) between 1 and 200),
  instructions    text check (length(instructions) <= 5000),
  max_attempts    int not null default 1 check (max_attempts between 1 and 20),
  -- Когда ученик видит правильные ответы: никогда / сразу после сдачи / после срока группы.
  reveal_answers  text not null default 'after_due' check (reveal_answers in ('never', 'after_submit', 'after_due')),
  status          text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint assessments_course_fkey foreign key (organization_id, course_id)
    references public.courses (organization_id, id) on delete restrict,
  constraint assessments_lesson_fkey foreign key (organization_id, course_id, lesson_id)
    references public.lessons (organization_id, course_id, id) on delete restrict,
  constraint assessments_scope_key unique (organization_id, course_id, id)
);

create table public.assessment_questions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  course_id       uuid not null,
  assessment_id   uuid not null,
  position        int not null check (position between 0 and 1000),
  type            text not null check (type in ('single_choice', 'multiple_choice', 'short_text', 'gap_fill')),
  skill           text not null default 'grammar' check (skill in ('grammar', 'vocabulary', 'reading', 'listening')),
  prompt          text not null check (length(btrim(prompt)) between 1 and 5000),
  -- Варианты без признака правильности: [{"id":"a","text":"…"}]. Для текстовых — [].
  options         jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  points          numeric(6, 2) not null default 1 check (points > 0),
  explanation     text check (length(explanation) <= 5000),
  created_at      timestamptz not null default now(),
  constraint assessment_questions_assessment_fkey foreign key (organization_id, course_id, assessment_id)
    references public.assessments (organization_id, course_id, id) on delete cascade,
  constraint assessment_questions_choice_check check (
    type not in ('single_choice', 'multiple_choice') or jsonb_array_length(options) between 2 and 10
  ),
  constraint assessment_questions_position_key unique (assessment_id, position),
  constraint assessment_questions_scope_key unique (organization_id, assessment_id, id)
);

-- Ключи ответов — отдельно. Ученику недоступны (RLS), используются только функцией проверки.
--   single_choice:   {"option": "b"}
--   multiple_choice: {"options": ["a", "c"]}
--   short_text:      {"accepted": ["went", "had gone"]}
--   gap_fill:        {"gaps": [["went"], ["to", "towards"]]}
create table public.assessment_answer_keys (
  question_id     uuid primary key references public.assessment_questions (id) on delete cascade,
  organization_id uuid not null,
  key             jsonb not null check (jsonb_typeof(key) = 'object')
);

create or replace function app.validate_answer_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.assessment_questions%rowtype;
  k jsonb := new.key;
begin
  select * into q from public.assessment_questions where id = new.question_id;
  if q.organization_id <> new.organization_id then
    raise exception 'answer key organization mismatch' using errcode = '23514';
  end if;
  case q.type
    when 'single_choice' then
      if not exists (select 1 from jsonb_array_elements(q.options) o where o ->> 'id' = k ->> 'option') then
        raise exception 'answer key must reference an existing option' using errcode = '23514';
      end if;
    when 'multiple_choice' then
      if jsonb_typeof(k -> 'options') is distinct from 'array' or jsonb_array_length(k -> 'options') = 0
         or exists (select 1 from jsonb_array_elements_text(k -> 'options') x
                    where not exists (select 1 from jsonb_array_elements(q.options) o where o ->> 'id' = x)) then
        raise exception 'answer key must reference existing options' using errcode = '23514';
      end if;
    when 'short_text' then
      if jsonb_typeof(k -> 'accepted') is distinct from 'array' or jsonb_array_length(k -> 'accepted') = 0 then
        raise exception 'short_text key requires accepted answers' using errcode = '23514';
      end if;
    when 'gap_fill' then
      if jsonb_typeof(k -> 'gaps') is distinct from 'array' or jsonb_array_length(k -> 'gaps') = 0
         or exists (select 1 from jsonb_array_elements(k -> 'gaps') g where jsonb_typeof(g) <> 'array' or jsonb_array_length(g) = 0) then
        raise exception 'gap_fill key requires accepted answers for every gap' using errcode = '23514';
      end if;
  end case;
  return new;
end;
$$;

create trigger assessment_answer_keys_validate before insert or update on public.assessment_answer_keys
  for each row execute function app.validate_answer_key();

-- Назначение теста группе: открытие и срок сдачи.
create table public.group_assessments (
  organization_id uuid not null,
  branch_id       uuid not null,
  group_id        uuid not null,
  assessment_id   uuid not null references public.assessments (id) on delete restrict,
  opens_at        timestamptz not null default now(),
  due_at          timestamptz,
  assigned_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (group_id, assessment_id),
  constraint group_assessments_group_fkey foreign key (organization_id, branch_id, group_id)
    references public.groups (organization_id, branch_id, id) on delete cascade,
  constraint group_assessments_dates_check check (due_at is null or due_at > opens_at)
);

-- Дополнительные попытки конкретному ученику («назначить повторно»).
create table public.assessment_retakes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  assessment_id   uuid not null references public.assessments (id) on delete restrict,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  extra_attempts  int not null check (extra_attempts between 1 and 5),
  reason          text check (length(reason) <= 500),
  granted_by      uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now()
);
create index assessment_retakes_lookup_idx on public.assessment_retakes (assessment_id, student_id);

create table public.assessment_attempts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  assessment_id   uuid not null references public.assessments (id) on delete restrict,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  attempt_no      int not null check (attempt_no >= 1),
  score           numeric(7, 2) not null check (score >= 0),
  max_score       numeric(7, 2) not null check (max_score > 0),
  submitted_at    timestamptz not null default now(),
  idempotency_key uuid not null unique,
  constraint assessment_attempts_unique_key unique (assessment_id, student_id, attempt_no),
  constraint assessment_attempts_score_range_check check (score <= max_score)
);
create index assessment_attempts_student_idx on public.assessment_attempts (student_id, submitted_at desc);

create table public.attempt_answers (
  attempt_id     uuid not null references public.assessment_attempts (id) on delete cascade,
  question_id    uuid not null references public.assessment_questions (id) on delete restrict,
  answer         jsonb not null check (jsonb_typeof(answer) = 'object' and length(answer::text) <= 5000),
  is_correct     boolean not null,
  points_awarded numeric(6, 2) not null check (points_awarded >= 0),
  primary key (attempt_id, question_id)
);

-- Попытки и ответы неизменны (результаты не переписываются задним числом).
create trigger assessment_attempts_append_only before update or delete on public.assessment_attempts
  for each row execute function app.forbid_mutation();
create trigger attempt_answers_append_only before update or delete on public.attempt_answers
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 4. Прогресс по урокам
-- ---------------------------------------------------------------------------
create table public.lesson_progress (
  organization_id uuid not null,
  lesson_id       uuid not null references public.lessons (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete cascade,
  status          text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  last_opened_at  timestamptz not null default now(),
  primary key (lesson_id, student_id),
  constraint lesson_progress_completed_check check ((status = 'completed') = (completed_at is not null))
);
create index lesson_progress_student_idx on public.lesson_progress (student_id, last_opened_at desc);

-- ---------------------------------------------------------------------------
-- 5. Проверка ответа (чистая функция) и отправка попытки
-- ---------------------------------------------------------------------------
create or replace function app.normalize_answer(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'));
$$;

-- Возвращает долю правильного ответа 0..1 для вопроса.
create or replace function app.grade_answer(p_type text, p_key jsonb, p_answer jsonb)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_total int;
  v_ok    int := 0;
  i       int;
begin
  case p_type
    when 'single_choice' then
      return case when (p_answer ->> 'option') = (p_key ->> 'option') then 1 else 0 end;
    when 'multiple_choice' then
      if jsonb_typeof(p_answer -> 'options') is distinct from 'array' then return 0; end if;
      return case when (select array_agg(x order by x) from jsonb_array_elements_text(p_answer -> 'options') x)
                     = (select array_agg(x order by x) from jsonb_array_elements_text(p_key -> 'options') x)
                  then 1 else 0 end;
    when 'short_text' then
      return case when exists (select 1 from jsonb_array_elements_text(p_key -> 'accepted') a
                               where app.normalize_answer(a) = app.normalize_answer(p_answer ->> 'text'))
                  then 1 else 0 end;
    when 'gap_fill' then
      v_total := jsonb_array_length(p_key -> 'gaps');
      if jsonb_typeof(p_answer -> 'gaps') is distinct from 'array' then return 0; end if;
      for i in 0 .. v_total - 1 loop
        if exists (select 1 from jsonb_array_elements_text(p_key -> 'gaps' -> i) a
                   where app.normalize_answer(a) = app.normalize_answer(p_answer -> 'gaps' ->> i)) then
          v_ok := v_ok + 1;
        end if;
      end loop;
      return round(v_ok::numeric / v_total, 4);
    else
      return 0;
  end case;
end;
$$;

-- Сколько попыток доступно ученику (база + пересдачи).
create or replace function app.allowed_attempts(p_assessment uuid, p_student uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select a.max_attempts + coalesce((select sum(r.extra_attempts)::int from public.assessment_retakes r
                                    where r.assessment_id = a.id and r.student_id = p_student), 0)
  from public.assessments a where a.id = p_assessment;
$$;

-- Тест открыт ученику: опубликован, назначен его группе и уже открыт.
create or replace function app.assessment_open_for_student(p_assessment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.assessments a
    join public.group_assessments ga on ga.assessment_id = a.id
    where a.id = p_assessment and a.status = 'published'
      and ga.opens_at <= now()
      and app.is_group_student(ga.group_id)
  );
$$;

-- Отправка попытки. Порядок: проверка доступа и лимита → оценка всех ответов по ключам →
-- одна вставка попытки с итоговым баллом → вставка ответов. Попытки неизменны (append-only).
-- Повтор с тем же idempotency_key возвращает уже сохранённую попытку (без дубля).
create or replace function public.submit_assessment_attempt(p_assessment uuid, p_answers jsonb, p_idempotency_key uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_existing public.assessment_attempts%rowtype;
  v_org      uuid;
  v_used     int;
  v_attempt  uuid;
  v_score    numeric := 0;
  v_max      numeric := 0;
  v_points   numeric;
  v_fraction numeric;
  v_answer   jsonb;
  v_results  jsonb := '[]'::jsonb;
  q          record;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select * into v_existing from public.assessment_attempts where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.student_id <> v_uid then
      raise exception 'idempotency key belongs to another attempt' using errcode = '42501';
    end if;
    return v_existing.id;
  end if;

  if jsonb_typeof(p_answers) is distinct from 'object' or length(p_answers::text) > 100000 then
    raise exception 'answers must be an object keyed by question id' using errcode = '22023';
  end if;
  if not app.assessment_open_for_student(p_assessment) then
    raise exception 'assessment is not available' using errcode = '42501';
  end if;

  -- Сериализуем одновременные отправки одного ученика по одному тесту.
  perform pg_advisory_xact_lock(hashtextextended(p_assessment::text || ':' || v_uid::text, 0));

  select * into v_existing from public.assessment_attempts where idempotency_key = p_idempotency_key;
  if found then
    return v_existing.id;
  end if;

  select count(*) into v_used from public.assessment_attempts where assessment_id = p_assessment and student_id = v_uid;
  if v_used >= app.allowed_attempts(p_assessment, v_uid) then
    raise exception 'no attempts left' using errcode = '23514';
  end if;

  for q in
    select qq.id, qq.type, qq.points, k.key
    from public.assessment_questions qq
    join public.assessment_answer_keys k on k.question_id = qq.id
    where qq.assessment_id = p_assessment
    order by qq.position
  loop
    v_answer := p_answers -> q.id::text;
    if v_answer is null or jsonb_typeof(v_answer) <> 'object' then
      v_answer := '{}'::jsonb;
    end if;
    v_fraction := app.grade_answer(q.type, q.key, v_answer);
    v_points := round(q.points * v_fraction, 2);
    v_max := v_max + q.points;
    v_score := v_score + v_points;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'question_id', q.id, 'answer', v_answer, 'is_correct', v_fraction = 1, 'points', v_points));
  end loop;

  if v_max = 0 then
    raise exception 'assessment has no gradable questions' using errcode = '23514';
  end if;

  select organization_id into v_org from public.assessments where id = p_assessment;
  insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key)
  values (v_org, p_assessment, v_uid, v_used + 1, v_score, v_max, p_idempotency_key)
  returning id into v_attempt;

  insert into public.attempt_answers (attempt_id, question_id, answer, is_correct, points_awarded)
  select v_attempt, (r ->> 'question_id')::uuid, r -> 'answer', (r ->> 'is_correct')::boolean, (r ->> 'points')::numeric
  from jsonb_array_elements(v_results) r;

  return v_attempt;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Кто видит попытки и может давать пересдачу
-- ---------------------------------------------------------------------------
-- Пользователь преподаёт этому ученику в группе этого курса.
create or replace function app.teaches_student(p_student uuid, p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.groups g
    join public.enrollments e on e.group_id = g.id and e.student_id = p_student and e.status <> 'cancelled'
    where g.course_id = p_course and app.is_group_teacher(g.id)
  );
$$;

create or replace function app.can_view_student_results(p_student uuid, p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student = (select auth.uid())
      or app.is_guardian_of(p_student)
      or app.teaches_student(p_student, p_course)
      or exists (
        select 1 from public.groups g
        join public.enrollments e on e.group_id = g.id and e.student_id = p_student
        where g.course_id = p_course and app.has_permission(g.organization_id, g.branch_id, 'learning.read_all')
      );
$$;

-- Раскрыть правильные ответы ученику/опекуну: по правилу теста.
-- after_due — после срока ВО ВСЕХ группах ученика, где тест назначен (срок обязателен).
create or replace function app.answers_revealed(p_assessment uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case a.reveal_answers
    when 'never' then false
    when 'after_submit' then true
    else exists (
      select 1 from public.group_assessments ga
      join public.enrollments e on e.group_id = ga.group_id and e.student_id = p_student and e.status <> 'cancelled'
      where ga.assessment_id = a.id
    ) and not exists (
      select 1 from public.group_assessments ga
      join public.enrollments e on e.group_id = ga.group_id and e.student_id = p_student and e.status <> 'cancelled'
      where ga.assessment_id = a.id and (ga.due_at is null or ga.due_at > now())
    )
  end
  from public.assessments a where a.id = p_assessment;
$$;

-- Разбор попытки. Ключи и пояснения — только редакторам курса, преподавателю ученика
-- или ученику/опекуну, когда правило теста это разрешает.
create or replace function public.attempt_review(p_attempt uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_att    public.assessment_attempts%rowtype;
  v_course uuid;
  v_staff  boolean;
  v_reveal boolean;
begin
  select * into v_att from public.assessment_attempts where id = p_attempt;
  if not found then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  select course_id into v_course from public.assessments where id = v_att.assessment_id;
  if not app.can_view_student_results(v_att.student_id, v_course) and not app.can_edit_course(v_course) then
    raise exception 'attempt not found' using errcode = '42501';
  end if;
  v_staff := app.can_edit_course(v_course) or app.teaches_student(v_att.student_id, v_course);
  v_reveal := v_staff or app.answers_revealed(v_att.assessment_id, v_att.student_id);

  return jsonb_build_object(
    'attemptId', v_att.id,
    'assessmentId', v_att.assessment_id,
    'attemptNo', v_att.attempt_no,
    'score', v_att.score::text,
    'maxScore', v_att.max_score::text,
    'submittedAt', v_att.submitted_at,
    'answersRevealed', v_reveal,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'position', q.position, 'type', q.type, 'skill', q.skill, 'prompt', q.prompt, 'options', q.options,
        'points', q.points::text,
        'answer', aa.answer,
        'isCorrect', aa.is_correct,
        'pointsAwarded', aa.points_awarded::text,
        'key', case when v_reveal then k.key end,
        'explanation', case when v_reveal then q.explanation end
      ) order by q.position)
      from public.attempt_answers aa
      join public.assessment_questions q on q.id = aa.question_id
      left join public.assessment_answer_keys k on k.question_id = q.id
      where aa.attempt_id = v_att.id), '[]'::jsonb)
  );
end;
$$;

-- Может ли пользователь дать ученику пересдачу: преподаёт ему в группе, где назначен тест.
create or replace function app.can_grant_retake(p_assessment uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_assessments ga
    join public.enrollments e on e.group_id = ga.group_id and e.student_id = p_student and e.status <> 'cancelled'
    where ga.assessment_id = p_assessment and app.is_group_teacher(ga.group_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. Прогресс: открыть/завершить урок; сводка по курсу из сохранённых данных
-- ---------------------------------------------------------------------------
create or replace function app.lesson_visible_to_student(p_lesson uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.lessons l
    join public.course_modules m on m.id = l.module_id
    where l.id = p_lesson and l.status = 'published' and m.status = 'published' and app.is_course_student(l.course_id)
  );
$$;

create or replace function public.track_lesson(p_lesson uuid, p_completed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null or not app.lesson_visible_to_student(p_lesson) then
    raise exception 'lesson is not available' using errcode = '42501';
  end if;
  select organization_id into v_org from public.lessons where id = p_lesson;
  insert into public.lesson_progress (organization_id, lesson_id, student_id, status, completed_at)
  values (v_org, p_lesson, v_uid, case when p_completed then 'completed' else 'in_progress' end, case when p_completed then now() end)
  on conflict (lesson_id, student_id) do update set
    last_opened_at = now(),
    -- Завершённый урок не «откатывается» повторным открытием.
    status = case when public.lesson_progress.status = 'completed' or p_completed then 'completed' else 'in_progress' end,
    completed_at = coalesce(public.lesson_progress.completed_at, case when p_completed then now() end);
end;
$$;

-- Сводка прогресса ученика по курсу. Всё вычисляется из сохранённых строк — без отдельного счётчика.
create or replace function public.course_progress(p_course uuid, p_student uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_student uuid := coalesce(p_student, auth.uid());
begin
  if v_student is null or not app.can_view_student_results(v_student, p_course) then
    raise exception 'progress not available' using errcode = '42501';
  end if;
  return (
    with published as (
      select l.id, l.title, l.position, m.position as module_position, m.id as module_id
      from public.lessons l join public.course_modules m on m.id = l.module_id
      where l.course_id = p_course and l.status = 'published' and m.status = 'published'
    ),
    progress as (
      select lp.* from public.lesson_progress lp join published p on p.id = lp.lesson_id where lp.student_id = v_student
    ),
    best as (
      select at.assessment_id, max(at.score) as best_score, max(at.max_score) as max_score, count(*) as attempts,
             max(at.submitted_at) as last_at
      from public.assessment_attempts at join public.assessments a on a.id = at.assessment_id
      where a.course_id = p_course and at.student_id = v_student
      group by at.assessment_id
    )
    select jsonb_build_object(
      'lessonsTotal', (select count(*) from published),
      'lessonsCompleted', (select count(*) from progress where status = 'completed'),
      'lastLessonId', (select lesson_id from progress order by last_opened_at desc limit 1),
      'nextLessonId', (select p.id from published p
                       where not exists (select 1 from progress pr where pr.lesson_id = p.id and pr.status = 'completed')
                       order by p.module_position, p.position limit 1),
      'completedLessonIds', coalesce((select jsonb_agg(lesson_id) from progress where status = 'completed'), '[]'::jsonb),
      'assessments', coalesce((select jsonb_agg(jsonb_build_object(
          'assessmentId', b.assessment_id, 'bestScore', b.best_score::text, 'maxScore', b.max_score::text,
          'attempts', b.attempts, 'lastAt', b.last_at)) from best b), '[]'::jsonb)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Целостность назначений
-- ---------------------------------------------------------------------------
create or replace function app.check_group_assessment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.assessments a join public.groups g on g.id = new.group_id
    where a.id = new.assessment_id and a.course_id = g.course_id and a.status = 'published'
  ) then
    raise exception 'only a published assessment of the group course can be assigned' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger group_assessments_check before insert or update on public.group_assessments
  for each row execute function app.check_group_assessment();

create trigger course_modules_set_updated_at before update on public.course_modules
  for each row execute function app.set_updated_at();
create trigger course_modules_immutable before update on public.course_modules
  for each row execute function app.forbid_column_change('organization_id', 'course_id');
create trigger lessons_set_updated_at before update on public.lessons
  for each row execute function app.set_updated_at();
create trigger lessons_immutable before update on public.lessons
  for each row execute function app.forbid_column_change('organization_id', 'course_id');
create trigger lesson_blocks_set_updated_at before update on public.lesson_blocks
  for each row execute function app.set_updated_at();
create trigger lesson_blocks_immutable before update on public.lesson_blocks
  for each row execute function app.forbid_column_change('organization_id', 'course_id', 'lesson_id');
create trigger assessments_set_updated_at before update on public.assessments
  for each row execute function app.set_updated_at();
create trigger assessments_immutable before update on public.assessments
  for each row execute function app.forbid_column_change('organization_id', 'course_id');
create trigger assessment_questions_immutable before update on public.assessment_questions
  for each row execute function app.forbid_column_change('organization_id', 'course_id', 'assessment_id');
create trigger group_assessments_immutable before update on public.group_assessments
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'group_id', 'assessment_id');
create trigger assessment_retakes_audit after insert on public.assessment_retakes
  for each row execute function app.audit_row();

-- Вопросы с уже сданными попытками менять нельзя — это исказило бы результаты.
create or replace function app.guard_answered_question()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qid uuid := case when tg_table_name = 'assessment_answer_keys' then coalesce(new.question_id, old.question_id) else coalesce(new.id, old.id) end;
begin
  if exists (select 1 from public.attempt_answers where question_id = v_qid) then
    raise exception 'question already has submitted answers; create a new assessment version' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger assessment_questions_guard before update or delete on public.assessment_questions
  for each row execute function app.guard_answered_question();
create trigger assessment_answer_keys_guard before update or delete on public.assessment_answer_keys
  for each row execute function app.guard_answered_question();

-- ---------------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------------
alter table public.course_modules         enable row level security;
alter table public.lessons                enable row level security;
alter table public.lesson_blocks          enable row level security;
alter table public.assessments            enable row level security;
alter table public.assessment_questions   enable row level security;
alter table public.assessment_answer_keys enable row level security;
alter table public.group_assessments      enable row level security;
alter table public.assessment_retakes     enable row level security;
alter table public.assessment_attempts    enable row level security;
alter table public.attempt_answers        enable row level security;
alter table public.lesson_progress        enable row level security;

-- Структура и материалы: редакторы — всё; остальные с доступом к курсу — только опубликованное.
create policy "course viewers read published modules" on public.course_modules
  for select to authenticated using (app.can_edit_course(course_id) or (status = 'published' and app.can_view_course(course_id)));
create policy "course editors write modules" on public.course_modules
  for insert to authenticated with check (app.can_edit_course(course_id));
create policy "course editors update modules" on public.course_modules
  for update to authenticated using (app.can_edit_course(course_id)) with check (app.can_edit_course(course_id));
create policy "course editors delete modules" on public.course_modules
  for delete to authenticated using (app.can_edit_course(course_id));

create policy "course viewers read published lessons" on public.lessons
  for select to authenticated using (
    app.can_edit_course(course_id)
    or (status = 'published' and app.can_view_course(course_id)
        and exists (select 1 from public.course_modules m where m.id = module_id and m.status = 'published'))
  );
create policy "course editors write lessons" on public.lessons
  for insert to authenticated with check (app.can_edit_course(course_id));
create policy "course editors update lessons" on public.lessons
  for update to authenticated using (app.can_edit_course(course_id)) with check (app.can_edit_course(course_id));
create policy "course editors delete lessons" on public.lessons
  for delete to authenticated using (app.can_edit_course(course_id));

create policy "lesson viewers read blocks" on public.lesson_blocks
  for select to authenticated using (exists (select 1 from public.lessons l where l.id = lesson_id));
create policy "course editors write blocks" on public.lesson_blocks
  for insert to authenticated with check (app.can_edit_course(course_id));
create policy "course editors update blocks" on public.lesson_blocks
  for update to authenticated using (app.can_edit_course(course_id)) with check (app.can_edit_course(course_id));
create policy "course editors delete blocks" on public.lesson_blocks
  for delete to authenticated using (app.can_edit_course(course_id));

-- Тесты: редакторы; ученик — только назначенные и открытые; руководство/опекун — опубликованные.
create or replace function app.can_view_assessment(p_assessment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assessments a
    where a.id = p_assessment
      and (
        app.can_edit_course(a.course_id)
        or app.assessment_open_for_student(a.id)
        or (a.status = 'published' and exists (
              select 1 from public.group_assessments ga join public.groups g on g.id = ga.group_id
              where ga.assessment_id = a.id
                and (app.is_group_teacher(g.id) or app.is_group_guardian(g.id)
                     or app.has_permission(g.organization_id, g.branch_id, 'learning.read_all'))))
      )
  );
$$;

create policy "permitted users read assessments" on public.assessments
  for select to authenticated using (app.can_view_assessment(id));
create policy "course editors create assessments" on public.assessments
  for insert to authenticated with check (app.can_edit_course(course_id) and created_by = (select auth.uid()));
create policy "course editors update assessments" on public.assessments
  for update to authenticated using (app.can_edit_course(course_id)) with check (app.can_edit_course(course_id));

create policy "permitted users read questions without keys" on public.assessment_questions
  for select to authenticated using (app.can_view_assessment(assessment_id));
create policy "course editors write questions" on public.assessment_questions
  for insert to authenticated with check (app.can_edit_course(course_id));
create policy "course editors update questions" on public.assessment_questions
  for update to authenticated using (app.can_edit_course(course_id)) with check (app.can_edit_course(course_id));
create policy "course editors delete questions" on public.assessment_questions
  for delete to authenticated using (app.can_edit_course(course_id));

-- Ключи: только редакторы курса. Ученикам — никогда (только через attempt_review по правилу).
create or replace function app.can_edit_question(p_question uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.assessment_questions q where q.id = p_question and app.can_edit_course(q.course_id));
$$;

create policy "course editors read keys" on public.assessment_answer_keys
  for select to authenticated using (app.can_edit_question(question_id));
create policy "course editors write keys" on public.assessment_answer_keys
  for insert to authenticated with check (app.can_edit_question(question_id));
create policy "course editors update keys" on public.assessment_answer_keys
  for update to authenticated using (app.can_edit_question(question_id)) with check (app.can_edit_question(question_id));
create policy "course editors delete keys" on public.assessment_answer_keys
  for delete to authenticated using (app.can_edit_question(question_id));

create policy "group members read assignments of tests" on public.group_assessments
  for select to authenticated using (app.can_read_group(group_id));
create policy "group teachers assign tests" on public.group_assessments
  for insert to authenticated with check (
    (app.is_group_teacher(group_id) or app.has_permission(organization_id, branch_id, 'group.manage')) and assigned_by = (select auth.uid())
  );
create policy "group teachers change test dates" on public.group_assessments
  for update to authenticated
  using (app.is_group_teacher(group_id) or app.has_permission(organization_id, branch_id, 'group.manage'))
  with check (app.is_group_teacher(group_id) or app.has_permission(organization_id, branch_id, 'group.manage'));
create policy "group teachers unassign tests" on public.group_assessments
  for delete to authenticated using (app.is_group_teacher(group_id) or app.has_permission(organization_id, branch_id, 'group.manage'));

create policy "student and teachers read retakes" on public.assessment_retakes
  for select to authenticated using (student_id = (select auth.uid()) or app.can_grant_retake(assessment_id, student_id));
create policy "teachers grant retakes" on public.assessment_retakes
  for insert to authenticated with check (app.can_grant_retake(assessment_id, student_id) and granted_by = (select auth.uid()));

create policy "permitted users read attempts" on public.assessment_attempts
  for select to authenticated using (
    exists (select 1 from public.assessments a where a.id = assessment_id and app.can_view_student_results(student_id, a.course_id))
  );
create policy "permitted users read attempt answers" on public.attempt_answers
  for select to authenticated using (exists (select 1 from public.assessment_attempts at where at.id = attempt_id));

create policy "permitted users read lesson progress" on public.lesson_progress
  for select to authenticated using (
    exists (select 1 from public.lessons l where l.id = lesson_id and app.can_view_student_results(student_id, l.course_id))
  );

-- ---------------------------------------------------------------------------
-- 10. Каталог: имена опубликовавших профиль преподавателей и расписание групп
-- ---------------------------------------------------------------------------
create or replace function public.public_catalog(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'title', c.title, 'description', c.description, 'format', c.format, 'kind', c.kind,
    'durationWeeks', c.duration_weeks, 'lessonsPerWeek', c.lessons_per_week,
    'language', jsonb_build_object('code', l.code, 'name', l.name),
    'level', jsonb_build_object('code', lv.code, 'title', lv.title, 'framework', lv.framework, 'order', lv.sort_order),
    'price', case when c.public_price is null then null else
      jsonb_build_object('amount', c.public_price::text, 'currency', c.public_price_currency, 'unit', c.public_price_unit) end,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branchId', g.branch_id, 'branch', b.name, 'city', b.city, 'startsOn', g.starts_on,
        'enrollment', g.enrollment_status,
        'scheduleNote', g.schedule_note,
        -- Только преподаватели, сами опубликовавшие профиль (этап 4).
        'teachers', coalesce((
          select jsonb_agg(t.display_name order by t.display_name)
          from public.group_teachers gt
          join public.teacher_public_profiles t on t.profile_id = gt.teacher_id and t.organization_id = gt.organization_id and t.status = 'published'
          where gt.group_id = g.id), '[]'::jsonb),
        'freeSeats', greatest(g.capacity - (select count(*) from public.enrollments e
                                             where e.group_id = g.id and e.status in ('pending', 'active')), 0)
      ) order by g.starts_on)
      from public.groups g join public.branches b on b.id = g.branch_id and b.status = 'active'
      where g.course_id = c.id and g.status in ('planned', 'active') and g.enrollment_status <> 'closed'), '[]'::jsonb)
  ) order by l.name, lv.sort_order, c.title), '[]'::jsonb)
  from public.courses c
  join public.languages l on l.id = c.language_id and l.status = 'active'
  join public.course_levels lv on lv.id = c.level_id
  where c.organization_id = app.public_org(p_slug) and c.status = 'published';
$$;

-- ---------------------------------------------------------------------------
-- 10b. Списки курсов для кабинета (один запрос вместо проверки каждого курса)
-- ---------------------------------------------------------------------------
create or replace function public.my_editable_courses()
returns table (id uuid, title text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.title, c.status from public.courses c
  where c.status <> 'archived' and app.can_edit_course(c.id)
  order by c.title;
$$;

-- Курсы, где пользователь учится сам или учится его подопечный.
create or replace function public.my_learning_courses()
returns table (id uuid, title text, student_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct c.id, c.title, e.student_id
  from public.enrollments e
  join public.groups g on g.id = e.group_id
  join public.courses c on c.id = g.course_id
  where e.status <> 'cancelled'
    and (app.is_group_student(g.id) and e.student_id = (select auth.uid())
         or app.is_guardian_of(e.student_id))
  order by c.title;
$$;

-- ---------------------------------------------------------------------------
-- 11. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.course_modules, public.lessons, public.lesson_blocks, public.assessments, public.assessment_questions,
  public.assessment_answer_keys, public.group_assessments, public.assessment_retakes, public.assessment_attempts,
  public.attempt_answers, public.lesson_progress from anon, authenticated;
grant select, insert, update, delete on public.course_modules, public.lessons, public.lesson_blocks, public.assessment_questions,
  public.assessment_answer_keys, public.group_assessments to authenticated;
grant select, insert, update on public.assessments to authenticated;
grant select, insert on public.assessment_retakes to authenticated;
grant select on public.assessment_attempts, public.attempt_answers, public.lesson_progress to authenticated;
grant all on public.course_modules, public.lessons, public.lesson_blocks, public.assessments, public.assessment_questions,
  public.assessment_answer_keys, public.group_assessments, public.assessment_retakes, public.assessment_attempts,
  public.attempt_answers, public.lesson_progress to service_role;

revoke all on function public.submit_assessment_attempt(uuid, jsonb, uuid), public.attempt_review(uuid),
  public.track_lesson(uuid, boolean), public.course_progress(uuid, uuid), public.my_editable_courses(),
  public.my_learning_courses() from public, anon;
grant execute on function public.submit_assessment_attempt(uuid, jsonb, uuid), public.attempt_review(uuid),
  public.track_lesson(uuid, boolean), public.course_progress(uuid, uuid), public.my_editable_courses(),
  public.my_learning_courses() to authenticated, service_role;
revoke all on function public.public_catalog(text) from public;
grant execute on function public.public_catalog(text) to anon, authenticated, service_role;

-- Функции, которые вызываются в RLS-политиках от имени пользователя.
grant execute on function app.is_course_student(uuid), app.is_course_teacher(uuid), app.can_edit_course(uuid),
  app.can_view_course(uuid), app.can_view_assessment(uuid), app.can_edit_question(uuid),
  app.assessment_open_for_student(uuid), app.can_view_student_results(uuid, uuid), app.can_grant_retake(uuid, uuid),
  app.teaches_student(uuid, uuid), app.lesson_visible_to_student(uuid)
  to authenticated, service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
