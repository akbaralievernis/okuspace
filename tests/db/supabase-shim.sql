-- ============================================================================
-- ТОЛЬКО ДЛЯ ТЕСТОВ. Минимальная эмуляция окружения Supabase для PGlite:
-- роли, схема auth, auth.users, auth.uid()/auth.jwt(), схема extensions.
-- В настоящем Supabase всё это уже существует — файл туда НЕ применяется.
-- Поведение auth.uid()/auth.jwt() повторяет Supabase: значения берутся из
-- request.jwt.claims, которые PostgREST выставляет на каждый запрос.
-- ============================================================================

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema extensions;
create schema auth;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create function auth.role() returns text
language sql stable
as $$
  select auth.jwt() ->> 'role';
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;
