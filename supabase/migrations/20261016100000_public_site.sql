-- ============================================================================
-- 0007 · Публичный сайт (этап 4): контент страниц, юридические документы
--        с версиями, публичные профили преподавателей, контакты филиалов,
--        публичные цены, слоты пробных занятий, входящие заявки.
-- Анонимный доступ — ТОЛЬКО через функции public_* (SECURITY DEFINER),
-- которые возвращают опубликованные данные без персональных полей.
-- Прямых привилегий на таблицы у anon по-прежнему нет.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Права
-- ---------------------------------------------------------------------------
insert into public.permissions (code, description) values
  ('site.manage', 'Редактировать страницы сайта, юридические документы и публикацию'),
  ('lead.read',   'Видеть входящие заявки с сайта'),
  ('lead.manage', 'Обрабатывать входящие заявки');

insert into public.role_permissions (role, permission) values
  ('org_director', 'site.manage'), ('org_director', 'lead.read'), ('org_director', 'lead.manage'),
  ('branch_manager', 'lead.read'), ('branch_manager', 'lead.manage'),
  ('admin', 'lead.read'), ('admin', 'lead.manage'),
  ('sales_manager', 'lead.read'), ('sales_manager', 'lead.manage');

-- ---------------------------------------------------------------------------
-- 2. Публичные контакты филиалов и цены курсов
-- ---------------------------------------------------------------------------
alter table public.branches
  add column phone text check (phone ~ '^\+?[0-9 ()-]{6,20}$'),
  add column email text check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

alter table public.courses
  add column public_price numeric(14, 2) check (public_price >= 0),
  add column public_price_currency char(3) check (public_price_currency ~ '^[A-Z]{3}$'),
  add column public_price_unit text check (public_price_unit in ('month', 'course', 'lesson', 'hour')),
  add constraint courses_public_price_pair_check check (
    (public_price is null) = (public_price_currency is null) and (public_price is null) = (public_price_unit is null)
  );

-- ---------------------------------------------------------------------------
-- 3. Публичный профиль преподавателя: публикует только сам преподаватель
--    (это и есть его согласие на публикацию имени и описания).
-- ---------------------------------------------------------------------------
create table public.teacher_public_profiles (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  display_name    text not null check (length(btrim(display_name)) between 2 and 120),
  bio             jsonb not null default '{}'::jsonb check (jsonb_typeof(bio) = 'object' and length(bio::text) <= 12000),
  languages       text[] not null default '{}' check (cardinality(languages) <= 10),
  status          text not null default 'draft' check (status in ('draft', 'published')),
  published_at    timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, profile_id),
  constraint teacher_public_profiles_published_check check (status = 'draft' or published_at is not null)
);

create or replace function app.guard_teacher_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.profile_id is distinct from old.profile_id or new.organization_id is distinct from old.organization_id then
    perform app.assert_active_role(new.organization_id, null, new.profile_id, 'teacher');
  end if;
  if tg_op = 'UPDATE' and (new.profile_id is distinct from old.profile_id or new.organization_id is distinct from old.organization_id) then
    raise exception 'teacher profile owner is immutable' using errcode = '42501';
  end if;
  -- Опубликовать может только сам преподаватель; руководство может только снять с публикации.
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    if auth.uid() is distinct from new.profile_id then
      raise exception 'only the teacher can publish their profile' using errcode = '42501';
    end if;
    new.published_at := now();
  end if;
  if new.status = 'draft' then
    new.published_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- assert_active_role требует совпадения филиала; преподаватель может быть в любом филиале организации.
create or replace function app.assert_active_role(p_org uuid, p_branch uuid, p_profile uuid, p_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.memberships
    where organization_id = p_org and profile_id = p_profile and role = p_role and status = 'active'
      and (p_branch is null or branch_id = p_branch or branch_id is null)
  ) then
    raise exception 'profile has no active % membership in this branch', p_role using errcode = '23514';
  end if;
end;
$$;

create trigger teacher_public_profiles_guard before insert or update on public.teacher_public_profiles
  for each row execute function app.guard_teacher_profile();

-- ---------------------------------------------------------------------------
-- 4. Страницы сайта (о школе, контакты, FAQ) — по языкам, с черновиком.
-- ---------------------------------------------------------------------------
create table public.public_pages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  slug            text not null check (slug in ('about', 'contacts', 'faq')),
  locale          text not null check (locale in ('ky', 'ru', 'en')),
  title           text not null check (length(btrim(title)) between 2 and 200),
  body            text not null check (length(body) between 1 and 50000),
  status          text not null default 'draft' check (status in ('draft', 'published')),
  updated_by      uuid references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint public_pages_unique_key unique (organization_id, slug, locale)
);

-- ---------------------------------------------------------------------------
-- 5. Юридические документы: версии; опубликованная версия неизменна.
--    Версия = дата редакции (YYYY-MM-DD), она же записывается в consents.
-- ---------------------------------------------------------------------------
create table public.legal_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind            text not null check (kind in ('privacy', 'terms', 'personal_data')),
  locale          text not null check (locale in ('ky', 'ru', 'en')),
  version         text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  title           text not null check (length(btrim(title)) between 2 and 200),
  body            text not null check (length(body) between 100 and 200000),
  status          text not null default 'draft' check (status in ('draft', 'published')),
  published_at    timestamptz,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint legal_documents_unique_key unique (organization_id, kind, locale, version),
  constraint legal_documents_published_check check (status = 'draft' or published_at is not null)
);

create or replace function app.guard_legal_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'published legal document cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status = 'published' then
    raise exception 'published legal document is immutable; create a new version' using errcode = '42501';
  end if;
  if new.status = 'published' then
    new.published_at := now();
  end if;
  return new;
end;
$$;

create trigger legal_documents_guard before insert or update or delete on public.legal_documents
  for each row execute function app.guard_legal_document();
create trigger legal_documents_audit after insert or update on public.legal_documents
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 6. Слоты пробных занятий
-- ---------------------------------------------------------------------------
create table public.trial_slots (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  course_id       uuid,
  period          tstzrange not null,
  format          text not null check (format in ('online', 'offline')),
  capacity        int not null check (capacity between 1 and 50),
  status          text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint trial_slots_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint trial_slots_course_fkey foreign key (organization_id, course_id)
    references public.courses (organization_id, id) on delete restrict,
  constraint trial_slots_period_check check (
    not isempty(period) and lower_inc(period) and not upper_inc(period)
    and not lower_inf(period) and not upper_inf(period)
    and upper(period) - lower(period) <= interval '3 hours'
  ),
  constraint trial_slots_scope_id_key unique (organization_id, id)
);
create index trial_slots_upcoming_idx on public.trial_slots (organization_id, lower(period)) where status = 'open';

-- ---------------------------------------------------------------------------
-- 7. Входящие заявки с сайта. Создаются только сервером (service role) через
--    submit_lead_request(): валидация, ограничение частоты — в приложении,
--    целостность и защита от дублей — здесь. Полноценная CRM — этап 8.
-- ---------------------------------------------------------------------------
create table public.lead_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  kind            text not null check (kind in ('trial', 'contact')),
  full_name       text not null check (length(btrim(full_name)) between 2 and 120),
  phone           text check (phone ~ '^\+?[0-9 ()-]{6,20}$'),
  email           text check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  message         text check (length(message) <= 2000),
  course_id       uuid,
  trial_slot_id   uuid,
  locale          text not null check (locale in ('ky', 'ru', 'en')),
  consent_version text not null check (consent_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  status          text not null default 'new' check (status in ('new', 'in_progress', 'done', 'spam')),
  dedupe_key      text not null unique check (dedupe_key ~ '^[0-9a-f]{64}$'),
  handled_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint lead_requests_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint lead_requests_course_fkey foreign key (organization_id, course_id)
    references public.courses (organization_id, id) on delete restrict,
  constraint lead_requests_slot_fkey foreign key (organization_id, trial_slot_id)
    references public.trial_slots (organization_id, id) on delete restrict,
  constraint lead_requests_contact_check check (phone is not null or email is not null),
  constraint lead_requests_trial_check check (kind <> 'trial' or trial_slot_id is not null)
);
create index lead_requests_inbox_idx on public.lead_requests (organization_id, status, created_at desc);

create trigger lead_requests_set_updated_at before update on public.lead_requests
  for each row execute function app.set_updated_at();
create trigger lead_requests_immutable before update on public.lead_requests
  for each row execute function app.forbid_column_change(
    'organization_id', 'branch_id', 'kind', 'full_name', 'phone', 'email', 'message',
    'course_id', 'trial_slot_id', 'locale', 'consent_version', 'dedupe_key', 'created_at');

-- Актуальная опубликованная версия документа (для согласий).
create or replace function app.current_legal_version(p_org uuid, p_kind text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select max(version) from public.legal_documents
  where organization_id = p_org and kind = p_kind and status = 'published';
$$;

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
  v_taken  int;
  v_id     uuid;
  v_branch uuid := p_branch;
begin
  select id into v_org from public.organizations where slug = p_org_slug and status = 'active';
  if v_org is null then
    raise exception 'organization not available' using errcode = '22023';
  end if;
  -- Согласие — на актуальную опубликованную политику конфиденциальности этой школы.
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
    select count(*) into v_taken from public.lead_requests where trial_slot_id = v_slot.id and status <> 'spam';
    if v_taken >= v_slot.capacity and not exists (select 1 from public.lead_requests where dedupe_key = p_dedupe_key) then
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

  -- Повторная отправка той же заявки возвращает уже созданную запись (идемпотентность).
  if v_id is null then
    select id into v_id from public.lead_requests where dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Публичные функции чтения (anon). Только опубликованное, без ПДн.
-- ---------------------------------------------------------------------------
create or replace function app.public_org(p_slug text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.organizations where slug = p_slug and status = 'active';
$$;

create or replace function public.public_site(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Нет активной школы с таким slug → 0 строк → функция возвращает NULL.
  select jsonb_build_object(
    'name', o.name,
    'slug', o.slug,
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'city', b.city, 'address', b.address,
                                          'phone', b.phone, 'email', b.email, 'timezone', b.timezone) order by b.city, b.name)
      from public.branches b where b.organization_id = o.id and b.status = 'active'), '[]'::jsonb),
    'legal', (
      select jsonb_object_agg(k.kind, app.current_legal_version(o.id, k.kind))
      from unnest(array['privacy', 'terms', 'personal_data']) as k(kind)),
    'pages', coalesce((
      select jsonb_agg(distinct p.slug) from public.public_pages p where p.organization_id = o.id and p.status = 'published'), '[]'::jsonb)
  )
  from public.organizations o
  where o.id = app.public_org(p_slug);
$$;

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

create or replace function public.public_levels(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', l.code, 'name', l.name,
    'levels', (select coalesce(jsonb_agg(jsonb_build_object('code', lv.code, 'title', lv.title, 'framework', lv.framework) order by lv.sort_order), '[]'::jsonb)
               from public.course_levels lv where lv.language_id = l.id)
  ) order by l.name), '[]'::jsonb)
  from public.languages l
  where l.organization_id = app.public_org(p_slug) and l.status = 'active';
$$;

create or replace function public.public_teachers(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('displayName', t.display_name, 'bio', t.bio, 'languages', t.languages) order by t.display_name), '[]'::jsonb)
  from public.teacher_public_profiles t
  where t.organization_id = app.public_org(p_slug)
    and t.status = 'published'
    and exists (select 1 from public.memberships m
                where m.organization_id = t.organization_id and m.profile_id = t.profile_id
                  and m.role = 'teacher' and m.status = 'active');
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
    'freeSpots', s.capacity - (select count(*) from public.lead_requests r where r.trial_slot_id = s.id and r.status <> 'spam')
  ) order by lower(s.period)), '[]'::jsonb)
  from public.trial_slots s
  join public.branches b on b.id = s.branch_id and b.status = 'active'
  left join public.courses c on c.id = s.course_id and c.status = 'published'
  where s.organization_id = app.public_org(p_slug)
    and s.status = 'open'
    and lower(s.period) > now()
    and lower(s.period) < now() + interval '60 days'
    and s.capacity > (select count(*) from public.lead_requests r where r.trial_slot_id = s.id and r.status <> 'spam');
$$;

create or replace function public.public_page(p_slug text, p_page text, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('title', p.title, 'body', p.body, 'updatedAt', p.updated_at)
  from public.public_pages p
  where p.organization_id = app.public_org(p_slug) and p.slug = p_page and p.locale = p_locale and p.status = 'published';
$$;

create or replace function public.public_legal(p_slug text, p_kind text, p_locale text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('title', d.title, 'body', d.body, 'version', d.version, 'publishedAt', d.published_at)
  from public.legal_documents d
  where d.organization_id = app.public_org(p_slug) and d.kind = p_kind and d.locale = p_locale and d.status = 'published'
  order by d.version desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 9. Согласия при регистрации: привязка к школе и к актуальным версиям
-- ---------------------------------------------------------------------------
alter table public.consents add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.consents drop constraint consents_unique_key;
alter table public.consents add constraint consents_unique_key unique nulls not distinct (profile_id, organization_id, kind, version);

create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta    jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_locale  text := v_meta ->> 'locale';
  v_org     uuid := app.public_org(v_meta ->> 'consent_org');
  v_privacy text := v_meta ->> 'consent_privacy_version';
  v_terms   text := v_meta ->> 'consent_terms_version';
begin
  insert into public.profiles (id, full_name, locale)
  values (
    new.id,
    left(coalesce(v_meta ->> 'full_name', ''), 200),
    case when v_locale in ('ky', 'ru', 'en') then v_locale else 'ru' end
  );

  -- Согласие записывается, только если версии совпадают с опубликованными документами школы.
  if v_org is not null
     and v_privacy = app.current_legal_version(v_org, 'privacy')
     and v_terms = app.current_legal_version(v_org, 'terms') then
    insert into public.consents (profile_id, organization_id, kind, version)
    values (new.id, v_org, 'privacy_policy', v_privacy), (new.id, v_org, 'terms', v_terms);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------------
alter table public.teacher_public_profiles enable row level security;
alter table public.public_pages            enable row level security;
alter table public.legal_documents         enable row level security;
alter table public.trial_slots             enable row level security;
alter table public.lead_requests           enable row level security;

create policy "teachers manage own public profile; site managers read" on public.teacher_public_profiles
  for select to authenticated using (profile_id = (select auth.uid()) or app.has_permission(organization_id, null, 'site.manage'));
create policy "teachers create own public profile" on public.teacher_public_profiles
  for insert to authenticated with check (profile_id = (select auth.uid()));
create policy "teachers edit own profile; site managers with mfa can unpublish" on public.teacher_public_profiles
  for update to authenticated
  using (profile_id = (select auth.uid()) or (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage')))
  with check (profile_id = (select auth.uid()) or (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage') and status = 'draft'));

create policy "site managers read pages" on public.public_pages
  for select to authenticated using (app.has_permission(organization_id, null, 'site.manage'));
create policy "site managers with mfa write pages" on public.public_pages
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage') and updated_by = (select auth.uid()));
create policy "site managers with mfa update pages" on public.public_pages
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage') and updated_by = (select auth.uid()));

create policy "site managers read legal documents" on public.legal_documents
  for select to authenticated using (app.has_permission(organization_id, null, 'site.manage'));
create policy "site managers with mfa create legal documents" on public.legal_documents
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage') and created_by = (select auth.uid()));
create policy "site managers with mfa edit draft legal documents" on public.legal_documents
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'));
create policy "site managers with mfa delete draft legal documents" on public.legal_documents
  for delete to authenticated using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'));

create policy "members read trial slots" on public.trial_slots
  for select to authenticated using (app.is_member(organization_id));
create policy "schedulers with mfa create trial slots" on public.trial_slots
  for insert to authenticated
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'schedule.manage') and created_by = (select auth.uid()));
create policy "schedulers with mfa update trial slots" on public.trial_slots
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'schedule.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'schedule.manage'));

create policy "lead readers see requests in scope" on public.lead_requests
  for select to authenticated using (app.has_permission(organization_id, branch_id, 'lead.read'));
create policy "lead managers with mfa process requests" on public.lead_requests
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'lead.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, branch_id, 'lead.manage') and handled_by = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 11. Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.teacher_public_profiles, public.public_pages, public.legal_documents, public.trial_slots,
  public.lead_requests from anon, authenticated;
grant select, insert, update on public.teacher_public_profiles, public.public_pages, public.trial_slots to authenticated;
grant select, insert, update, delete on public.legal_documents to authenticated;
grant select, update (status, handled_by) on public.lead_requests to authenticated;
grant all on public.teacher_public_profiles, public.public_pages, public.legal_documents, public.trial_slots,
  public.lead_requests to service_role;

revoke all on function public.submit_lead_request(text, text, uuid, text, text, text, text, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_lead_request(text, text, uuid, text, text, text, text, uuid, uuid, text, text, text) to service_role;

revoke all on function public.public_site(text), public.public_catalog(text), public.public_levels(text), public.public_teachers(text),
  public.public_trial_slots(text), public.public_page(text, text, text), public.public_legal(text, text, text) from public;
grant execute on function public.public_site(text), public.public_catalog(text), public.public_levels(text), public.public_teachers(text),
  public.public_trial_slots(text), public.public_page(text, text, text), public.public_legal(text, text, text)
  to anon, authenticated, service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
