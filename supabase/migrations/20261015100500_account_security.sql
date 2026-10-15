-- ============================================================================
-- 0006 · Безопасность аккаунтов (этап 3): MFA для управления ролями,
--        приглашение директора владельцем платформы, принятие приглашений,
--        серверный rate limit, список сессий, согласия на обработку ПДн,
--        события безопасности о самом пользователе.
-- Потоки: docs/architecture/AUTH_FLOWS.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Право выдавать роли — функция от произвольного профиля (для проверки
--    пригласившего при принятии приглашения) + обязательный MFA для текущего.
-- ---------------------------------------------------------------------------
create or replace function app.profile_can_assign_role(p_profile uuid, p_org uuid, p_branch uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      -- Директора назначает только владелец платформы.
      when p_role = 'org_director' then
        p_branch is null and exists (select 1 from public.platform_admins where profile_id = p_profile)
      else exists (
        select 1
        from public.memberships m
        join public.organizations o on o.id = m.organization_id and o.status = 'active'
        join public.role_permissions rp on rp.role = m.role and rp.permission = 'member.manage'
        join public.role_grants rg on rg.granter_role = m.role and rg.grantable_role = p_role
        where m.profile_id = p_profile
          and m.organization_id = p_org
          and m.status = 'active'
          and (m.branch_id is null or m.branch_id = p_branch)
      )
    end;
$$;

-- Текущий пользователь может выдать роль: право + пройденный MFA (aal2).
create or replace function app.can_assign_role(p_org uuid, p_branch uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_aal() = 'aal2'
     and app.profile_can_assign_role((select auth.uid()), p_org, p_branch, p_role);
$$;

-- Управление опекунством — тоже привилегированное действие: требуем MFA.
drop policy "scoped staff can create guardian links" on public.guardian_links;
drop policy "scoped staff can update guardian links" on public.guardian_links;
create policy "scoped staff with mfa can create guardian links" on public.guardian_links
  for insert to authenticated
  with check (app.current_aal() = 'aal2' and app.staff_can(student_id, 'member.manage'));
create policy "scoped staff with mfa can update guardian links" on public.guardian_links
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.staff_can(student_id, 'member.manage'))
  with check (app.current_aal() = 'aal2' and app.staff_can(student_id, 'member.manage'));

-- Создание организаций владельцем платформы — тоже только с MFA.
drop policy "platform admins can create organizations" on public.organizations;
create policy "platform admins with mfa can create organizations" on public.organizations
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- 2. Принятие приглашения. Одинаковая ошибка для «нет / истекло / отозвано /
--    чужой email» — чтобы нельзя было перебирать токены и адреса.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(auth.jwt() ->> 'email');
  v_inv   public.invitations%rowtype;
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) < 32 or length(p_token) > 200 then
    raise exception 'invalid invitation' using errcode = '22023';
  end if;

  select * into v_inv from public.invitations
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;

  if not found
     or v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or v_email is null
     or v_email <> v_inv.email then
    raise exception 'invalid invitation' using errcode = '22023';
  end if;

  -- Пригласивший мог потерять права после отправки приглашения.
  if v_inv.created_by is null
     or not app.profile_can_assign_role(v_inv.created_by, v_inv.organization_id, v_inv.branch_id, v_inv.role) then
    raise exception 'invalid invitation' using errcode = '22023';
  end if;

  begin
    insert into public.memberships (organization_id, branch_id, profile_id, role, created_by)
    values (v_inv.organization_id, v_inv.branch_id, v_uid, v_inv.role, v_inv.created_by)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'membership already exists' using errcode = '23505';
  end;

  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_id;
end;
$$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- Приглашение директора — только владелец платформы с MFA.
create policy "platform admins with mfa can invite directors" on public.invitations
  for insert to authenticated with check (
    role = 'org_director' and branch_id is null and app.current_aal() = 'aal2' and app.is_platform_admin()
    and created_by = (select auth.uid()) and accepted_at is null and revoked_at is null
  );
create policy "platform admins can read director invitations" on public.invitations
  for select to authenticated using (role = 'org_director' and app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- 3. Серверный rate limit (фиксированное окно). Ключи — хеши, не ПДн.
--    Доступ только у service role (вызывается сервером, не браузером).
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  bucket       text not null check (bucket ~ '^[a-z_]+:[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits         int not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
create index rate_limits_window_idx on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;
-- Политик нет намеренно: ни anon, ни authenticated не имеют доступа.
comment on table public.rate_limits is 'Счётчики ограничений частоты. Только service role через hit_rate_limit().';

create or replace function public.hit_rate_limit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits   int;
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits (bucket, window_start, hits) values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  delete from public.rate_limits where window_start < now() - interval '2 days';
  return v_hits <= p_limit;
end;
$$;

revoke all on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Активные сессии пользователя (только чтение своих).
--    Завершение «всех остальных» — штатным signOut({ scope: 'others' }).
-- ---------------------------------------------------------------------------
create or replace function public.list_my_sessions()
returns table (id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text, aal text, is_current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.created_at, s.updated_at, s.user_agent, host(s.ip), s.aal::text,
         s.id::text = (auth.jwt() ->> 'session_id')
  from auth.sessions s
  where s.user_id = (select auth.uid())
  order by s.updated_at desc nulls last;
$$;

revoke all on function public.list_my_sessions() from public, anon;
grant execute on function public.list_my_sessions() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Согласия на обработку персональных данных (append-only).
--    Записываются триггером при регистрации из метаданных Supabase Auth.
-- ---------------------------------------------------------------------------
create table public.consents (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('privacy_policy', 'terms')),
  version     text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  accepted_at timestamptz not null default now(),
  constraint consents_unique_key unique (profile_id, kind, version)
);
alter table public.consents enable row level security;
create policy "users can read own consents" on public.consents
  for select to authenticated using (profile_id = (select auth.uid()));
create trigger consents_append_only before update or delete on public.consents
  for each row execute function app.forbid_mutation();
create trigger consents_no_truncate before truncate on public.consents
  for each statement execute function app.forbid_mutation();

-- Регистрация: профиль + язык + согласия (без каких-либо ролей).
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta    jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_locale  text := v_meta ->> 'locale';
  v_version text := v_meta ->> 'consent_version';
begin
  insert into public.profiles (id, full_name, locale)
  values (
    new.id,
    left(coalesce(v_meta ->> 'full_name', ''), 200),
    case when v_locale in ('ky', 'ru', 'en') then v_locale else 'ru' end
  );

  if v_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    insert into public.consents (profile_id, kind, version)
    values (new.id, 'privacy_policy', v_version), (new.id, 'terms', v_version);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Журнал аудита: субъект записи (о ком она) и чтение своих событий.
-- ---------------------------------------------------------------------------
alter table public.audit_logs add column subject_profile_id uuid;
create index audit_logs_subject_idx on public.audit_logs (subject_profile_id, at desc);

create or replace function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new  jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old  jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row  jsonb := coalesce(v_new, v_old);
  v_diff jsonb := '{}'::jsonb;
  v_key  text;
begin
  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> 'updated_at' and v_new -> v_key is distinct from v_old -> v_key then
        v_diff := v_diff || jsonb_build_object(v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      return new;
    end if;
  else
    v_diff := v_row;
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity, entity_id, diff, subject_profile_id)
  values (
    coalesce(
      nullif(v_row ->> 'organization_id', '')::uuid,
      case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid end
    ),
    nullif(v_row ->> 'branch_id', '')::uuid,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(nullif(v_row ->> 'id', '')::uuid, nullif(v_row ->> 'profile_id', '')::uuid),
    v_diff - 'token_hash',
    coalesce(
      nullif(v_row ->> 'profile_id', '')::uuid,
      nullif(v_row ->> 'student_id', '')::uuid,
      nullif(v_row ->> 'payer_id', '')::uuid
    )
  );
  return coalesce(new, old);
end;
$$;

create policy "users can read audit entries about themselves" on public.audit_logs
  for select to authenticated using (subject_profile_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Привилегии
-- ---------------------------------------------------------------------------
revoke all on public.rate_limits, public.consents from anon, authenticated;
grant select on public.consents to authenticated;
grant all on public.rate_limits, public.consents to service_role;

-- profile_can_assign_role не выдаётся authenticated: она отвечает про ЧУЖИЕ права
-- и вызывается только из definer-функций (can_assign_role, accept_invitation).
grant execute on function app.can_assign_role(uuid, uuid, text) to authenticated, service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
