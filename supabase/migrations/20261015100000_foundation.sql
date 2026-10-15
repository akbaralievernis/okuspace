-- ============================================================================
-- 0001 · Фундамент: расширения, приватная схема app, общие триггерные функции.
-- Правила: docs/architecture/CONVENTIONS.md §3. Только вперёд.
-- ============================================================================

-- Нужен для EXCLUDE-ограничений по (uuid, tstzrange) — защита от двойного бронирования.
create extension if not exists btree_gist with schema extensions;

-- Приватная схема: не публикуется через Data API Supabase (там только public).
create schema if not exists app;
comment on schema app is 'Okuspace: внутренние функции прав доступа и целостности. Не публикуется через API.';
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- Функции по умолчанию исполняемы всеми (PUBLIC). ALTER DEFAULT PRIVILEGES ... IN SCHEMA
-- не отзывает глобальные права, поэтому каждая миграция в конце явно делает
-- REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app и выдаёт права точечно.

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Append-only: запрет UPDATE/DELETE/TRUNCATE для финансовых записей и аудита.
-- Действует для всех ролей, включая service_role.
-- ---------------------------------------------------------------------------
create or replace function app.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'append-only: % on %.% is not allowed', tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001', hint = 'Create a corrective record instead.';
end;
$$;

-- ---------------------------------------------------------------------------
-- Неизменяемые столбцы: TG_ARGV — список имён столбцов, которые нельзя менять.
-- Закрывает подмену organization_id / branch_id / владельца через UPDATE.
-- ---------------------------------------------------------------------------
create or replace function app.forbid_column_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if v_old -> v_col is distinct from v_new -> v_col then
      raise exception 'column %.% is immutable', tg_table_name, v_col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

-- Уровень аутентификации из JWT (aal2 = пройден MFA).
create or replace function app.current_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1');
$$;

grant execute on function app.current_aal() to authenticated, service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
