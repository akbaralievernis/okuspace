-- ============================================================================
-- 0002 · Tenancy и identity: организации, филиалы, профили, членства, RBAC,
--        опекунство, приглашения, журнал аудита. RLS — в этой же миграции.
-- Модель: docs/architecture/DATA_MODEL.md §2, потоки: AUTH_FLOWS.md §6.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Справочники RBAC (меняются только миграциями)
-- ---------------------------------------------------------------------------
create table public.roles (
  code        text primary key check (code ~ '^[a-z_]+$'),
  description text not null
);

create table public.permissions (
  code        text primary key check (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description text not null
);

create table public.role_permissions (
  role       text not null references public.roles (code) on delete cascade,
  permission text not null references public.permissions (code) on delete cascade,
  primary key (role, permission)
);

-- Какие роли может выдавать обладатель роли (защита от повышения прав).
create table public.role_grants (
  granter_role   text not null references public.roles (code) on delete cascade,
  grantable_role text not null references public.roles (code) on delete cascade,
  primary key (granter_role, grantable_role)
);

insert into public.roles (code, description) values
  ('org_director',   'Центральный директор школы — вся организация'),
  ('branch_manager', 'Руководитель филиала'),
  ('admin',          'Администратор филиала'),
  ('sales_manager',  'Менеджер по продажам'),
  ('accountant',     'Бухгалтер'),
  ('teacher',        'Преподаватель — только назначенные группы'),
  ('student',        'Ученик — только собственное обучение'),
  ('parent',         'Родитель — только связанные ученики');

insert into public.permissions (code, description) values
  ('org.manage',        'Изменять настройки организации'),
  ('branch.manage',     'Создавать и изменять филиалы'),
  ('member.read',       'Видеть участников и их контактные данные в своём охвате'),
  ('member.manage',     'Выдавать, блокировать и отзывать роли (в пределах role_grants)'),
  ('catalog.manage',    'Управлять языками, уровнями и курсами'),
  ('group.read',        'Видеть группы в своём охвате'),
  ('group.manage',      'Создавать группы и назначать преподавателей'),
  ('schedule.manage',   'Управлять аудиториями и занятиями'),
  ('enrollment.manage', 'Записывать учеников в группы'),
  ('learning.read_all', 'Видеть задания и работы всех групп своего охвата'),
  ('finance.read',      'Видеть счета и платежи'),
  ('finance.write',     'Создавать счета, платежи и распределения'),
  ('finance.refund',    'Оформлять возвраты'),
  ('audit.read',        'Читать журнал аудита');

insert into public.role_permissions (role, permission) values
  ('org_director', 'org.manage'), ('org_director', 'branch.manage'), ('org_director', 'member.read'),
  ('org_director', 'member.manage'), ('org_director', 'catalog.manage'), ('org_director', 'group.read'),
  ('org_director', 'group.manage'), ('org_director', 'schedule.manage'), ('org_director', 'enrollment.manage'),
  ('org_director', 'learning.read_all'), ('org_director', 'finance.read'), ('org_director', 'audit.read'),
  ('branch_manager', 'branch.manage'), ('branch_manager', 'member.read'), ('branch_manager', 'member.manage'),
  ('branch_manager', 'group.read'), ('branch_manager', 'group.manage'), ('branch_manager', 'schedule.manage'),
  ('branch_manager', 'enrollment.manage'), ('branch_manager', 'learning.read_all'), ('branch_manager', 'finance.read'),
  ('admin', 'member.read'), ('admin', 'member.manage'), ('admin', 'group.read'), ('admin', 'group.manage'),
  ('admin', 'schedule.manage'), ('admin', 'enrollment.manage'),
  ('sales_manager', 'member.read'), ('sales_manager', 'member.manage'), ('sales_manager', 'group.read'),
  ('sales_manager', 'enrollment.manage'),
  ('accountant', 'member.read'), ('accountant', 'group.read'), ('accountant', 'finance.read'),
  ('accountant', 'finance.write'), ('accountant', 'finance.refund');

-- org_director не выдаёт org_director: нового директора назначает владелец платформы.
insert into public.role_grants (granter_role, grantable_role) values
  ('org_director', 'branch_manager'), ('org_director', 'admin'), ('org_director', 'sales_manager'),
  ('org_director', 'accountant'), ('org_director', 'teacher'), ('org_director', 'student'), ('org_director', 'parent'),
  ('branch_manager', 'admin'), ('branch_manager', 'sales_manager'), ('branch_manager', 'accountant'),
  ('branch_manager', 'teacher'), ('branch_manager', 'student'), ('branch_manager', 'parent'),
  ('admin', 'teacher'), ('admin', 'student'), ('admin', 'parent'),
  ('sales_manager', 'student'), ('sales_manager', 'parent');

-- ---------------------------------------------------------------------------
-- Организации и филиалы
-- ---------------------------------------------------------------------------
create table public.organizations (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) between 2 and 200),
  slug             text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 63),
  status           text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  ai_enabled       boolean not null default false,
  default_timezone text not null default 'Asia/Bishkek',
  default_currency char(3) not null default 'KGS' check (default_currency ~ '^[A-Z]{3}$'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.branches (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name            text not null check (length(btrim(name)) between 2 and 200),
  city            text not null check (length(btrim(city)) between 2 and 100),
  address         text check (length(address) <= 500),
  timezone        text not null default 'Asia/Bishkek',
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint branches_org_id_key unique (organization_id, id),
  constraint branches_org_name_key unique (organization_id, name)
);

-- Часовой пояс проверяется по базе tz (CHECK не может обращаться к каталогу).
create or replace function app.validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- to_jsonb: PL/pgSQL разбирает обе ветки CASE, а поля у таблиц разные.
  v_tz text := coalesce(to_jsonb(new) ->> 'timezone', to_jsonb(new) ->> 'default_timezone');
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'unknown time zone: %', v_tz using errcode = '22023';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Профили (1:1 с auth.users). Чувствительные поля — в отдельной таблице.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '' check (length(full_name) <= 200),
  locale      text not null default 'ru' check (locale in ('ky', 'ru', 'en')),
  avatar_path text check (length(avatar_path) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.profile_private (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  phone      text check (phone ~ '^\+?[0-9 ()-]{6,20}$'),
  birth_date date check (birth_date > date '1900-01-01'),
  updated_at timestamptz not null default now()
);

-- Владельцы платформы: управляют организациями, а не данными школ.
create table public.platform_admins (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Членства: роль человека в организации (и филиале).
-- ---------------------------------------------------------------------------
create table public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  profile_id      uuid not null references public.profiles (id) on delete restrict,
  role            text not null references public.roles (code) on delete restrict,
  status          text not null default 'active' check (status in ('active', 'blocked', 'revoked')),
  status_reason   text check (length(status_reason) <= 500),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint memberships_org_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  -- Директор — на всю организацию; филиальные роли — строго с филиалом.
  constraint memberships_director_scope_check check (role <> 'org_director' or branch_id is null),
  constraint memberships_branch_required_check
    check (role not in ('branch_manager', 'admin', 'teacher', 'student', 'parent') or branch_id is not null),
  constraint memberships_reason_check check (status = 'active' or status_reason is not null)
);

create unique index memberships_unique_active_idx
  on public.memberships (organization_id, profile_id, role, branch_id) nulls not distinct
  where status <> 'revoked';
create index memberships_profile_idx on public.memberships (profile_id) where status = 'active';
create index memberships_org_branch_idx on public.memberships (organization_id, branch_id);

-- Родитель ↔ ученик внутри организации.
create table public.guardian_links (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  guardian_id     uuid not null references public.profiles (id) on delete restrict,
  student_id      uuid not null references public.profiles (id) on delete restrict,
  status          text not null default 'active' check (status in ('active', 'revoked')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint guardian_links_distinct_check check (guardian_id <> student_id),
  constraint guardian_links_unique_key unique (organization_id, guardian_id, student_id)
);
create index guardian_links_student_idx on public.guardian_links (student_id);

-- Приглашения сотрудников: в БД хранится только SHA-256 токена (принятие — этап 3).
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  branch_id       uuid,
  email           text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role            text not null references public.roles (code) on delete restrict,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  accepted_by     uuid references public.profiles (id) on delete set null,
  revoked_at      timestamptz,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint invitations_org_branch_fkey foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete restrict,
  constraint invitations_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint invitations_final_state_check check (accepted_at is null or revoked_at is null)
);

-- ---------------------------------------------------------------------------
-- Журнал аудита: append-only, запись только через триггеры (SECURITY DEFINER).
-- actor_id без FK — запись переживает удаление профиля.
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id              bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete restrict,
  branch_id       uuid,
  actor_id        uuid,
  action          text not null check (action in ('insert', 'update', 'delete')),
  entity          text not null,
  entity_id       uuid,
  diff            jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);
create index audit_logs_org_at_idx on public.audit_logs (organization_id, at desc);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id);

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

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity, entity_id, diff)
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
    v_diff - 'token_hash'
  );
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Функции прав доступа. SECURITY DEFINER: читают членства в обход RLS,
-- но всегда только про текущего пользователя (auth.uid()).
-- ---------------------------------------------------------------------------
create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins where profile_id = (select auth.uid()));
$$;

create or replace function app.is_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    where m.organization_id = p_org and m.profile_id = (select auth.uid()) and m.status = 'active'
  );
$$;

-- Есть ли у пользователя право в охвате (организация + филиал).
-- p_branch = null — ресурс уровня организации: подходят только членства без филиала.
create or replace function app.has_permission(p_org uuid, p_branch uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    join public.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where m.profile_id = (select auth.uid())
      and m.organization_id = p_org
      and m.status = 'active'
      and (m.branch_id is null or m.branch_id = p_branch)
  );
$$;

-- Может ли пользователь выдать/изменить роль p_role в охвате.
create or replace function app.can_assign_role(p_org uuid, p_branch uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    join public.role_permissions rp on rp.role = m.role and rp.permission = 'member.manage'
    join public.role_grants rg on rg.granter_role = m.role and rg.grantable_role = p_role
    where m.profile_id = (select auth.uid())
      and m.organization_id = p_org
      and m.status = 'active'
      and (m.branch_id is null or m.branch_id = p_branch)
  );
$$;

-- Есть ли у пользователя право p_permission над участником p_profile
-- (в охвате хотя бы одного неотозванного членства этого участника).
create or replace function app.staff_can(p_profile uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships t
    join public.memberships m on m.organization_id = t.organization_id
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    join public.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where t.profile_id = p_profile
      and t.status <> 'revoked'
      and m.profile_id = (select auth.uid())
      and m.status = 'active'
      and (m.branch_id is null or m.branch_id = t.branch_id)
  );
$$;

create or replace function app.is_guardian_of(p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.guardian_links gl
    join public.memberships m
      on m.organization_id = gl.organization_id and m.profile_id = gl.guardian_id
     and m.role = 'parent' and m.status = 'active'
    join public.organizations o on o.id = gl.organization_id and o.status = 'active'
    where gl.guardian_id = (select auth.uid()) and gl.student_id = p_student and gl.status = 'active'
  );
$$;

-- Проверка роли участника (используется триггерами целостности).
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
      and (branch_id = p_branch or branch_id is null)
  ) then
    raise exception 'profile has no active % membership in this branch', p_role using errcode = '23514';
  end if;
end;
$$;

create or replace function app.assert_member(p_org uuid, p_profile uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.memberships
    where organization_id = p_org and profile_id = p_profile and status <> 'revoked'
  ) then
    raise exception 'profile is not a member of this organization' using errcode = '23514';
  end if;
end;
$$;

-- Только владелец платформы меняет статус организации (блокировка тенанта).
create or replace function app.guard_organization_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null and not app.is_platform_admin() then
    raise exception 'only platform admins can change organization status' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Профиль создаётся автоматически при регистрации в Supabase Auth. Роли не выдаются.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

grant execute on function
  app.is_platform_admin(), app.is_member(uuid), app.has_permission(uuid, uuid, text),
  app.can_assign_role(uuid, uuid, text), app.staff_can(uuid, text), app.is_guardian_of(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Триггеры
-- ---------------------------------------------------------------------------
create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function app.set_updated_at();
create trigger organizations_validate_tz before insert or update of default_timezone on public.organizations
  for each row execute function app.validate_timezone();
create trigger organizations_guard before update on public.organizations
  for each row execute function app.guard_organization_update();
create trigger organizations_audit after insert or update on public.organizations
  for each row execute function app.audit_row();

create trigger branches_set_updated_at before update on public.branches
  for each row execute function app.set_updated_at();
create trigger branches_validate_tz before insert or update of timezone on public.branches
  for each row execute function app.validate_timezone();
create trigger branches_immutable before update on public.branches
  for each row execute function app.forbid_column_change('organization_id');

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();
create trigger profile_private_set_updated_at before update on public.profile_private
  for each row execute function app.set_updated_at();

create trigger platform_admins_audit after insert or delete on public.platform_admins
  for each row execute function app.audit_row();

create trigger memberships_set_updated_at before update on public.memberships
  for each row execute function app.set_updated_at();
create trigger memberships_immutable before update on public.memberships
  for each row execute function app.forbid_column_change('organization_id', 'profile_id');
create trigger memberships_audit after insert or update on public.memberships
  for each row execute function app.audit_row();

create trigger guardian_links_set_updated_at before update on public.guardian_links
  for each row execute function app.set_updated_at();
create trigger guardian_links_immutable before update on public.guardian_links
  for each row execute function app.forbid_column_change('organization_id', 'guardian_id', 'student_id');
create trigger guardian_links_audit after insert or update on public.guardian_links
  for each row execute function app.audit_row();

create trigger invitations_immutable before update on public.invitations
  for each row execute function app.forbid_column_change('organization_id', 'branch_id', 'email', 'role', 'token_hash', 'created_by');
create trigger invitations_audit after insert or update on public.invitations
  for each row execute function app.audit_row();

create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function app.forbid_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.role_grants      enable row level security;
alter table public.organizations    enable row level security;
alter table public.branches         enable row level security;
alter table public.profiles         enable row level security;
alter table public.profile_private  enable row level security;
alter table public.platform_admins  enable row level security;
alter table public.memberships      enable row level security;
alter table public.guardian_links   enable row level security;
alter table public.invitations      enable row level security;
alter table public.audit_logs       enable row level security;

-- Справочники RBAC: только чтение для вошедших пользователей.
create policy "authenticated can read roles" on public.roles for select to authenticated using (true);
create policy "authenticated can read permissions" on public.permissions for select to authenticated using (true);
create policy "authenticated can read role permissions" on public.role_permissions for select to authenticated using (true);
create policy "authenticated can read role grants" on public.role_grants for select to authenticated using (true);

-- Организации
create policy "members and platform admins can read organizations" on public.organizations
  for select to authenticated using (app.is_member(id) or app.is_platform_admin());
create policy "platform admins can create organizations" on public.organizations
  for insert to authenticated with check (app.is_platform_admin());
create policy "directors and platform admins can update organizations" on public.organizations
  for update to authenticated
  using (app.is_platform_admin() or app.has_permission(id, null, 'org.manage'))
  with check (app.is_platform_admin() or app.has_permission(id, null, 'org.manage'));

-- Филиалы
create policy "members can read branches of their organization" on public.branches
  for select to authenticated using (app.is_member(organization_id) or app.is_platform_admin());
create policy "org-level managers can create branches" on public.branches
  for insert to authenticated with check (app.has_permission(organization_id, null, 'branch.manage'));
create policy "branch managers can update their branch" on public.branches
  for update to authenticated
  using (app.has_permission(organization_id, id, 'branch.manage'))
  with check (app.has_permission(organization_id, id, 'branch.manage'));

-- Профили: свой профиль; остальные правила видимости — в миграции 0003 (после групп).
create policy "users can read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "users can update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Личные данные: владелец, сотрудники с member.read в охвате, опекун.
create policy "owner, scoped staff and guardians can read private profile" on public.profile_private
  for select to authenticated using (
    profile_id = (select auth.uid()) or app.staff_can(profile_id, 'member.read') or app.is_guardian_of(profile_id)
  );
create policy "owner can insert private profile" on public.profile_private
  for insert to authenticated with check (profile_id = (select auth.uid()));
create policy "owner can update private profile" on public.profile_private
  for update to authenticated using (profile_id = (select auth.uid())) with check (profile_id = (select auth.uid()));

-- Владельцы платформы: видят список; изменения — только через service role / SQL.
create policy "platform admins can read platform admins" on public.platform_admins
  for select to authenticated using (profile_id = (select auth.uid()) or app.is_platform_admin());

-- Членства. Собственное членство изменить нельзя (защита от повышения прав).
create policy "users read own memberships, staff read scoped memberships" on public.memberships
  for select to authenticated using (
    profile_id = (select auth.uid()) or app.has_permission(organization_id, branch_id, 'member.read')
  );
create policy "managers can grant allowed roles to others" on public.memberships
  for insert to authenticated with check (
    profile_id <> (select auth.uid()) and app.can_assign_role(organization_id, branch_id, role)
  );
create policy "managers can change allowed memberships of others" on public.memberships
  for update to authenticated
  using (profile_id <> (select auth.uid()) and app.can_assign_role(organization_id, branch_id, role))
  with check (profile_id <> (select auth.uid()) and app.can_assign_role(organization_id, branch_id, role));

-- Опекунство
create policy "participants and scoped staff can read guardian links" on public.guardian_links
  for select to authenticated using (
    guardian_id = (select auth.uid()) or student_id = (select auth.uid()) or app.staff_can(student_id, 'member.read')
  );
create policy "scoped staff can create guardian links" on public.guardian_links
  for insert to authenticated with check (app.staff_can(student_id, 'member.manage'));
create policy "scoped staff can update guardian links" on public.guardian_links
  for update to authenticated
  using (app.staff_can(student_id, 'member.manage')) with check (app.staff_can(student_id, 'member.manage'));

-- Приглашения
create policy "role granters can read invitations" on public.invitations
  for select to authenticated using (app.can_assign_role(organization_id, branch_id, role));
create policy "role granters can create invitations" on public.invitations
  for insert to authenticated with check (
    app.can_assign_role(organization_id, branch_id, role) and created_by = (select auth.uid())
    and accepted_at is null and revoked_at is null
  );
create policy "role granters can revoke invitations" on public.invitations
  for update to authenticated
  using (app.can_assign_role(organization_id, branch_id, role))
  with check (app.can_assign_role(organization_id, branch_id, role) and accepted_at is null);

-- Аудит: чтение по праву audit.read; записи о платформе — владельцам платформы.
create policy "auditors can read audit logs" on public.audit_logs
  for select to authenticated using (
    (organization_id is not null and app.has_permission(organization_id, branch_id, 'audit.read'))
    or (organization_id is null and app.is_platform_admin())
  );

-- ---------------------------------------------------------------------------
-- Привилегии (явно; anon — без доступа к данным)
-- ---------------------------------------------------------------------------
revoke all on public.roles, public.permissions, public.role_permissions, public.role_grants,
  public.organizations, public.branches, public.profiles, public.profile_private, public.platform_admins,
  public.memberships, public.guardian_links, public.invitations, public.audit_logs
  from anon, authenticated;

grant select on public.roles, public.permissions, public.role_permissions, public.role_grants,
  public.platform_admins, public.audit_logs to authenticated;
grant select, insert, update on public.organizations, public.branches, public.memberships,
  public.guardian_links, public.invitations, public.profile_private to authenticated;
grant select, update (full_name, locale, avatar_path) on public.profiles to authenticated;

grant all on public.roles, public.permissions, public.role_permissions, public.role_grants,
  public.organizations, public.branches, public.profiles, public.profile_private, public.platform_admins,
  public.memberships, public.guardian_links, public.invitations, public.audit_logs
  to service_role;

-- Права на функции app: только явно выданные выше (см. 0001).
revoke execute on all functions in schema app from public, anon;
