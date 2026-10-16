-- =============================================================================
-- Этап 7. AI Language Lab.
--
--  * AI выключен по умолчанию; школа включает его сама (ai.manage + MFA) и задаёт
--    месячный бюджет и дневной лимит запросов на человека. Голос — отдельный
--    выключатель, который остаётся выключенным до выбора провайдера распознавания
--    речи и правового основания (ADR-0009).
--  * ai_calls — журнал каждого обращения к провайдеру: резерв до вызова, фактический
--    расход после. Бюджет и лимиты проверяются в БД под блокировкой школы.
--    Итог вызова записывает только сервер (service role) — пользователь не может
--    «удешевить» свой вызов.
--  * Диалоги и AI-отзывы хранятся для истории и показателей прогресса. Любой AI-отзыв
--    ученик или преподаватель может оспорить; спор видит и разбирает преподаватель.
--  * Упражнения из AI проверяются в БД по сохранённым ответам, а не моделью.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Право управлять AI школы (директор, с MFA)
-- ---------------------------------------------------------------------------
insert into public.permissions (code, description) values
  ('ai.manage', 'Включать AI для школы, задавать лимиты и смотреть расход');
insert into public.role_permissions (role, permission) values ('org_director', 'ai.manage');

-- ---------------------------------------------------------------------------
-- 2. Настройки AI школы
-- ---------------------------------------------------------------------------
create table public.ai_settings (
  organization_id          uuid primary key references public.organizations (id) on delete restrict,
  enabled                  boolean not null default false,
  -- Деньги провайдера — в миллионных долях доллара (целые числа, без округлений float).
  monthly_budget_micro_usd bigint not null default 0 check (monthly_budget_micro_usd between 0 and 1000000000000),
  user_daily_requests      int not null default 30 check (user_daily_requests between 0 and 1000),
  voice_enabled            boolean not null default false,
  updated_by               uuid references public.profiles (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger ai_settings_set_updated_at before update on public.ai_settings
  for each row execute function app.set_updated_at();
create trigger ai_settings_audit after insert or update on public.ai_settings
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 3. Журнал обращений к провайдеру
-- ---------------------------------------------------------------------------
create table public.ai_calls (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete restrict,
  profile_id         uuid not null references public.profiles (id) on delete restrict,
  feature            text not null check (feature in ('conversation', 'writing_check', 'grammar', 'exercises')),
  status             text not null default 'pending' check (status in ('pending', 'ok', 'error', 'timeout', 'refused', 'unavailable', 'invalid_output')),
  model              text check (length(model) <= 100),
  input_tokens       int check (input_tokens >= 0),
  output_tokens      int check (output_tokens >= 0),
  reserved_micro_usd bigint not null check (reserved_micro_usd between 1 and 10000000),
  cost_micro_usd     bigint check (cost_micro_usd between 0 and 100000000),
  error_code         text check (length(error_code) <= 100),
  created_at         timestamptz not null default now(),
  finished_at        timestamptz,
  constraint ai_calls_finished_check check ((status = 'pending') = (finished_at is null)),
  constraint ai_calls_cost_check check (status = 'pending' or cost_micro_usd is not null)
);
create index ai_calls_org_created_idx on public.ai_calls (organization_id, created_at);
create index ai_calls_profile_created_idx on public.ai_calls (profile_id, created_at);

-- Вызов завершается один раз: pending → итог. Потом строка неизменна; удалять нельзя.
create or replace function app.guard_ai_call()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'append-only: ai_calls cannot be deleted' using errcode = 'P0001';
  end if;
  if old.status <> 'pending' then
    raise exception 'append-only: finished ai call cannot be changed' using errcode = 'P0001';
  end if;
  if (new.id, new.organization_id, new.profile_id, new.feature, new.reserved_micro_usd, new.created_at)
     is distinct from (old.id, old.organization_id, old.profile_id, old.feature, old.reserved_micro_usd, old.created_at) then
    raise exception 'ai call identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ai_calls_guard before update or delete on public.ai_calls
  for each row execute function app.guard_ai_call();
create trigger ai_calls_no_truncate before truncate on public.ai_calls
  for each statement execute function app.forbid_mutation();

-- Сколько школа потратила в текущем месяце (UTC): факт + резерв незавершённых свежих вызовов.
create or replace function app.ai_month_spend(p_org uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case
           when status <> 'pending' then cost_micro_usd
           when created_at > now() - interval '15 minutes' then reserved_micro_usd
           else 0 end), 0)::bigint
    from public.ai_calls
   where organization_id = p_org and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
$$;

/**
 * Начать обращение к AI: проверки школы, лимитов и бюджета, резерв стоимости.
 * Ошибки (P0001): 'ai disabled', 'ai rate limited', 'ai daily limit', 'ai budget exceeded'.
 */
create or replace function public.ai_begin(p_org uuid, p_feature text, p_reserve_micro_usd bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_set public.ai_settings%rowtype;
  v_id  uuid;
begin
  if v_uid is null or not app.is_member(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_reserve_micro_usd is null or p_reserve_micro_usd not between 1 and 10000000 then
    raise exception 'invalid reservation' using errcode = '22023';
  end if;
  select * into v_set from public.ai_settings where organization_id = p_org;
  if v_set.organization_id is null or not v_set.enabled then
    raise exception 'ai disabled' using errcode = 'P0001';
  end if;
  -- Блокировка школы сериализует проверку бюджета параллельных запросов.
  perform pg_advisory_xact_lock(hashtextextended('ai:' || p_org::text, 0));
  if (select count(*) from public.ai_calls where profile_id = v_uid and created_at > now() - interval '1 minute') >= 6 then
    raise exception 'ai rate limited' using errcode = 'P0001';
  end if;
  if (select count(*) from public.ai_calls
       where profile_id = v_uid and organization_id = p_org and created_at > now() - interval '24 hours') >= v_set.user_daily_requests then
    raise exception 'ai daily limit' using errcode = 'P0001';
  end if;
  if app.ai_month_spend(p_org) + p_reserve_micro_usd > v_set.monthly_budget_micro_usd then
    raise exception 'ai budget exceeded' using errcode = 'P0001';
  end if;
  insert into public.ai_calls (organization_id, profile_id, feature, reserved_micro_usd)
  values (p_org, v_uid, p_feature, p_reserve_micro_usd)
  returning id into v_id;
  return v_id;
end;
$$;

-- Итог вызова — только сервер приложения (service role).
create or replace function public.ai_finish(
  p_call uuid, p_status text, p_model text, p_input_tokens int, p_output_tokens int, p_cost_micro_usd bigint, p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_calls
     set status = p_status, model = p_model, input_tokens = p_input_tokens, output_tokens = p_output_tokens,
         cost_micro_usd = coalesce(p_cost_micro_usd, 0), error_code = p_error_code, finished_at = now()
   where id = p_call and status = 'pending';
  if not found then
    raise exception 'ai call is not pending' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Диалоги
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  scenario        text not null check (scenario in ('everyday', 'cafe', 'travel', 'doctor', 'job_interview', 'exam_speaking', 'free')),
  target_language text not null check (target_language ~ '^[a-z]{2,3}$'),
  level           text check (level ~ '^[A-Za-z0-9.+-]{1,16}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index ai_conversations_profile_idx on public.ai_conversations (profile_id, created_at desc);

create table public.ai_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (length(btrim(content)) between 1 and 8000),
  call_id         uuid references public.ai_calls (id) on delete restrict,
  created_at      timestamptz not null default now(),
  -- Ответ ассистента всегда связан с учтённым вызовом.
  constraint ai_messages_call_check check (role = 'user' or call_id is not null)
);
create index ai_messages_conversation_idx on public.ai_messages (conversation_id, id);

create trigger ai_conversations_set_updated_at before update on public.ai_conversations
  for each row execute function app.set_updated_at();
create trigger ai_conversations_immutable before update on public.ai_conversations
  for each row execute function app.forbid_column_change('organization_id', 'profile_id', 'scenario', 'target_language');
create trigger ai_messages_no_update before update on public.ai_messages
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 5. AI-отзывы, споры и практика
-- ---------------------------------------------------------------------------
create table public.ai_feedback (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  kind            text not null check (kind in ('writing_check', 'grammar', 'exercises')),
  input           text not null check (length(btrim(input)) between 1 and 4000),
  result          jsonb not null check (jsonb_typeof(result) = 'object' and length(result::text) <= 100000),
  call_id         uuid not null references public.ai_calls (id) on delete restrict,
  created_at      timestamptz not null default now()
);
create index ai_feedback_profile_idx on public.ai_feedback (profile_id, created_at desc);

create trigger ai_feedback_no_update before update on public.ai_feedback
  for each row execute function app.forbid_mutation();

-- Кто видит AI-результаты ученика: сам ученик, опекун, преподаватель его группы,
-- руководство с learning.read_all в филиале его записи.
create or replace function app.can_view_ai_results(p_org uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student = (select auth.uid())
      or app.is_guardian_of(p_student)
      or exists (
        select 1 from public.enrollments e
        where e.organization_id = p_org and e.student_id = p_student and e.status <> 'cancelled'
          and (app.is_group_teacher(e.group_id) or app.has_permission(e.organization_id, e.branch_id, 'learning.read_all'))
      );
$$;

-- Разбирает спор: преподаватель группы ученика или руководство (не сам ученик и не опекун).
create or replace function app.can_resolve_ai_dispute(p_org uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.enrollments e
    where e.organization_id = p_org and e.student_id = p_student and e.status <> 'cancelled'
      and (app.is_group_teacher(e.group_id) or app.has_permission(e.organization_id, e.branch_id, 'learning.read_all'))
  );
$$;

-- Для интерфейса: может ли текущий пользователь разбирать споры по этому отзыву.
create or replace function public.ai_can_resolve(p_feedback uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select app.can_resolve_ai_dispute(f.organization_id, f.profile_id) from public.ai_feedback f where f.id = p_feedback), false);
$$;

create table public.ai_feedback_disputes (
  id           uuid primary key default gen_random_uuid(),
  feedback_id  uuid not null references public.ai_feedback (id) on delete cascade,
  opened_by    uuid not null references public.profiles (id) on delete cascade,
  comment      text not null check (length(btrim(comment)) between 3 and 2000),
  status       text not null default 'open' check (status in ('open', 'upheld', 'rejected')),
  resolution   text check (length(btrim(resolution)) between 1 and 2000),
  resolved_by  uuid references public.profiles (id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint ai_feedback_disputes_once_key unique (feedback_id, opened_by),
  constraint ai_feedback_disputes_resolved_check check ((status = 'open') = (resolved_at is null) and (status = 'open' or resolution is not null))
);

-- Решение по спору принимается один раз и только разбирающим; суть спора не меняется.
create or replace function app.guard_ai_dispute()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fb public.ai_feedback%rowtype;
begin
  select * into v_fb from public.ai_feedback where id = new.feedback_id;
  if old.status <> 'open' then
    raise exception 'dispute is already resolved' using errcode = '23514';
  end if;
  if (new.feedback_id, new.opened_by, new.comment, new.created_at) is distinct from (old.feedback_id, old.opened_by, old.comment, old.created_at) then
    raise exception 'dispute is immutable' using errcode = '42501';
  end if;
  if new.resolved_by is distinct from auth.uid() or not app.can_resolve_ai_dispute(v_fb.organization_id, v_fb.profile_id) then
    raise exception 'not allowed to resolve' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ai_feedback_disputes_guard before update on public.ai_feedback_disputes
  for each row execute function app.guard_ai_dispute();
create trigger ai_feedback_disputes_audit after insert or update on public.ai_feedback_disputes
  for each row execute function app.audit_row();

create table public.ai_practice_results (
  id          uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.ai_feedback (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  answers     jsonb not null check (jsonb_typeof(answers) = 'object' and length(answers::text) <= 20000),
  -- Не «total»: так в схеме называются только денежные суммы.
  correct_count int not null check (correct_count >= 0),
  item_count    int not null check (item_count between 1 and 50 and correct_count <= item_count),
  created_at  timestamptz not null default now()
);
create index ai_practice_results_profile_idx on public.ai_practice_results (profile_id, created_at desc);
create trigger ai_practice_results_no_update before update on public.ai_practice_results
  for each row execute function app.forbid_mutation();

/**
 * Проверка ответов на AI-упражнения: по ключам, сохранённым вместе с упражнениями,
 * той же нормализацией, что и тесты LMS. Модель в проверке не участвует.
 * p_answers: { "<exerciseId>": "ответ" }.
 */
create or replace function public.record_practice(p_feedback uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fb      public.ai_feedback%rowtype;
  v_ex      jsonb;
  v_total   int := 0;
  v_correct int := 0;
  v_items   jsonb := '[]'::jsonb;
  v_ok      boolean;
begin
  select * into v_fb from public.ai_feedback where id = p_feedback;
  if v_fb.id is null or v_fb.profile_id is distinct from auth.uid() or v_fb.kind <> 'exercises' then
    raise exception 'practice is not available' using errcode = '42501';
  end if;
  if jsonb_typeof(p_answers) is distinct from 'object' or length(p_answers::text) > 20000 then
    raise exception 'invalid answers' using errcode = '22023';
  end if;
  for v_ex in select * from jsonb_array_elements(v_fb.result -> 'exercises') loop
    v_total := v_total + 1;
    v_ok := exists (
      select 1 from jsonb_array_elements_text(v_ex -> 'accepted') a
      where app.normalize_answer(a) = app.normalize_answer(p_answers ->> (v_ex ->> 'id'))
        and app.normalize_answer(a) <> ''
    );
    if v_ok then v_correct := v_correct + 1; end if;
    v_items := v_items || jsonb_build_object('id', v_ex ->> 'id', 'correct', v_ok);
  end loop;
  if v_total = 0 then
    raise exception 'no exercises' using errcode = '23514';
  end if;
  insert into public.ai_practice_results (feedback_id, profile_id, answers, correct_count, item_count)
  values (p_feedback, auth.uid(), p_answers, v_correct, v_total);
  return jsonb_build_object('correct', v_correct, 'total', v_total, 'items', v_items);
end;
$$;

-- Показатели AI-практики ученика за период: число диалогов, реплик, проверок письма,
-- найденных ошибок по категориям, результаты упражнений.
create or replace function public.ai_lab_stats(p_student uuid default null, p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_student uuid := coalesce(p_student, auth.uid());
  v_since   timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  if v_student is null or not (
       v_student = auth.uid() or app.is_guardian_of(v_student)
       or exists (select 1 from public.memberships m where m.profile_id = v_student and m.status = 'active'
                  and app.can_view_ai_results(m.organization_id, v_student))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'conversations', (select count(*) from public.ai_conversations where profile_id = v_student and created_at >= v_since),
    'userTurns', (select count(*) from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
                   where c.profile_id = v_student and m.role = 'user' and m.created_at >= v_since),
    'writingChecks', (select count(*) from public.ai_feedback where profile_id = v_student and kind = 'writing_check' and created_at >= v_since),
    'corrections', coalesce((
       select jsonb_object_agg(category, n) from (
         select c ->> 'category' as category, count(*) as n
           from public.ai_feedback f, jsonb_array_elements(f.result -> 'corrections') c
          where f.profile_id = v_student and f.kind = 'writing_check' and f.created_at >= v_since
          group by 1) x), '{}'::jsonb),
    'practice', jsonb_build_object(
       'sets', (select count(*) from public.ai_practice_results where profile_id = v_student and created_at >= v_since),
       'correct', (select coalesce(sum(correct_count), 0) from public.ai_practice_results where profile_id = v_student and created_at >= v_since),
       'total', (select coalesce(sum(item_count), 0) from public.ai_practice_results where profile_id = v_student and created_at >= v_since)),
    'openDisputes', (select count(*) from public.ai_feedback_disputes d join public.ai_feedback f on f.id = d.feedback_id
                      where f.profile_id = v_student and d.status = 'open')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
alter table public.ai_settings          enable row level security;
alter table public.ai_calls             enable row level security;
alter table public.ai_conversations     enable row level security;
alter table public.ai_messages          enable row level security;
alter table public.ai_feedback          enable row level security;
alter table public.ai_feedback_disputes enable row level security;
alter table public.ai_practice_results  enable row level security;

create policy "members read ai settings of their school" on public.ai_settings
  for select to authenticated using (app.is_member(organization_id));
create policy "ai managers with mfa create settings" on public.ai_settings
  for insert to authenticated with check (
    app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'ai.manage') and updated_by = (select auth.uid())
  );
create policy "ai managers with mfa change settings" on public.ai_settings
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'ai.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'ai.manage') and updated_by = (select auth.uid()));

create policy "users read own ai calls; ai managers read school usage" on public.ai_calls
  for select to authenticated using (profile_id = (select auth.uid()) or app.has_permission(organization_id, null, 'ai.manage'));

create policy "owners read own conversations" on public.ai_conversations
  for select to authenticated using (profile_id = (select auth.uid()));
create policy "members start own conversations" on public.ai_conversations
  for insert to authenticated with check (profile_id = (select auth.uid()) and app.is_member(organization_id));
create policy "owners delete own conversations" on public.ai_conversations
  for delete to authenticated using (profile_id = (select auth.uid()));

create policy "owners read own conversation messages" on public.ai_messages
  for select to authenticated using (
    exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.profile_id = (select auth.uid()))
  );
-- Реплики ассистента пишет только сервер (service role) — пользователь не может их подделать.
create policy "owners add own user messages" on public.ai_messages
  for insert to authenticated with check (
    role = 'user' and call_id is null
    and exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.profile_id = (select auth.uid()))
  );

create policy "permitted users read ai feedback" on public.ai_feedback
  for select to authenticated using (app.can_view_ai_results(organization_id, profile_id));

create policy "permitted users read disputes" on public.ai_feedback_disputes
  for select to authenticated using (
    exists (select 1 from public.ai_feedback f where f.id = feedback_id and app.can_view_ai_results(f.organization_id, f.profile_id))
  );
create policy "student or teacher opens a dispute" on public.ai_feedback_disputes
  for insert to authenticated with check (
    opened_by = (select auth.uid()) and status = 'open'
    and exists (select 1 from public.ai_feedback f where f.id = feedback_id
                and (f.profile_id = (select auth.uid()) or app.can_resolve_ai_dispute(f.organization_id, f.profile_id)))
  );
create policy "teachers resolve disputes" on public.ai_feedback_disputes
  for update to authenticated
  using (exists (select 1 from public.ai_feedback f where f.id = feedback_id and app.can_resolve_ai_dispute(f.organization_id, f.profile_id)))
  with check (resolved_by = (select auth.uid()));

create policy "permitted users read practice results" on public.ai_practice_results
  for select to authenticated using (
    exists (select 1 from public.ai_feedback f where f.id = feedback_id and app.can_view_ai_results(f.organization_id, f.profile_id))
  );

-- ---------------------------------------------------------------------------
-- 7. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.ai_settings, public.ai_calls, public.ai_conversations, public.ai_messages, public.ai_feedback,
  public.ai_feedback_disputes, public.ai_practice_results from anon, authenticated;
grant select, insert, update on public.ai_settings to authenticated;
grant select on public.ai_calls, public.ai_feedback, public.ai_practice_results to authenticated;
grant select, insert, delete on public.ai_conversations to authenticated;
grant select, insert on public.ai_messages to authenticated;
grant select, insert on public.ai_feedback_disputes to authenticated;
grant update (status, resolution, resolved_by, resolved_at) on public.ai_feedback_disputes to authenticated;
grant all on public.ai_settings, public.ai_calls, public.ai_conversations, public.ai_messages, public.ai_feedback,
  public.ai_feedback_disputes, public.ai_practice_results to service_role;

revoke all on function public.ai_begin(uuid, text, bigint), public.ai_finish(uuid, text, text, int, int, bigint, text),
  public.record_practice(uuid, jsonb), public.ai_lab_stats(uuid, int), public.ai_can_resolve(uuid) from public, anon;
grant execute on function public.ai_begin(uuid, text, bigint), public.record_practice(uuid, jsonb), public.ai_lab_stats(uuid, int),
  public.ai_can_resolve(uuid) to authenticated, service_role;
revoke execute on function public.ai_finish(uuid, text, text, int, int, bigint, text) from authenticated;
grant execute on function public.ai_finish(uuid, text, text, int, int, bigint, text) to service_role;

grant execute on function app.can_view_ai_results(uuid, uuid), app.can_resolve_ai_dispute(uuid, uuid) to authenticated, service_role;

-- Права на функции app: только явно выданные выше.
revoke execute on all functions in schema app from public, anon;
