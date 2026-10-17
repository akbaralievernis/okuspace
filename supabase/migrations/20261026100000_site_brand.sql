-- =============================================================================
-- Сайт школы под реальный учебный центр (American Dream): не только языки, курсы
-- по филиалам, WhatsApp филиалов, содержимое главной страницы и заявка «на курс».
--
--  * courses: язык и уровень необязательны (математика, ОРТ, программирование, 1С);
--    category — раздел сайта; age_note — возраст; site_code — код курса во внешних
--    системах (Telegram-бот школы).
--  * branches: whatsapp и site_number (номер филиала во внешних системах).
--  * branch_courses — какие курсы ведёт филиал (карточки филиалов, фильтр, форма).
--  * site_settings — содержимое главной (тексты hero, цифры, акции, клубы, результаты,
--    соцсети) на трёх языках; проверяется схемой в приложении, читается функцией.
--  * lead_requests: «для ребёнка / для себя», имя и возраст ребёнка, несколько
--    филиалов, «откуда узнали». Приём — submit_site_request (только service role).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Курсы и филиалы
-- ---------------------------------------------------------------------------
alter table public.courses alter column language_id drop not null;
alter table public.courses alter column level_id drop not null;
-- Длительность у части курсов школа не фиксирует (по уровню, по договорённости) — не выдумываем.
alter table public.courses alter column duration_weeks drop not null;
alter table public.courses alter column lessons_per_week drop not null;
alter table public.courses
  add column category  text check (category in ('english', 'exams', 'languages', 'school', 'it', 'other')),
  add column age_note  text check (length(btrim(age_note)) between 1 and 100),
  add column site_code text check (site_code ~ '^[A-Za-z0-9 &/()._+-]{1,60}$'),
  add constraint courses_level_needs_language_check check (level_id is null or language_id is not null);
create unique index courses_site_code_key on public.courses (organization_id, site_code) where site_code is not null;

alter table public.branches
  add column whatsapp    text check (whatsapp ~ '^\+[0-9]{10,15}$'),
  add column site_number int check (site_number between 1 and 999);
create unique index branches_site_number_key on public.branches (organization_id, site_number) where site_number is not null;

create table public.branch_courses (
  organization_id uuid not null,
  branch_id       uuid not null,
  course_id       uuid not null,
  primary key (branch_id, course_id),
  constraint branch_courses_branch_fkey foreign key (organization_id, branch_id) references public.branches (organization_id, id) on delete cascade,
  constraint branch_courses_course_fkey foreign key (organization_id, course_id) references public.courses (organization_id, id) on delete cascade
);
create index branch_courses_course_idx on public.branch_courses (course_id);

-- ---------------------------------------------------------------------------
-- 2. Содержимое сайта
-- ---------------------------------------------------------------------------
create table public.site_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  content         jsonb not null check (jsonb_typeof(content) = 'object' and length(content::text) <= 100000),
  updated_by      uuid references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now()
);
create trigger site_settings_set_updated_at before update on public.site_settings
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Заявка «на курс»
-- ---------------------------------------------------------------------------
alter table public.lead_requests
  add column for_child  boolean,
  add column child_name text check (length(btrim(child_name)) between 1 and 120),
  add column child_age  smallint check (child_age between 2 and 99),
  add column branch_ids uuid[] check (cardinality(branch_ids) between 1 and 10),
  add column heard_from text check (heard_from in ('whatsapp', 'instagram', 'ads', 'relatives', 'other')),
  add constraint lead_requests_child_check check (for_child is not true or (child_name is not null and child_age is not null));

create or replace function public.submit_site_request(
  p_org_slug text, p_for_child boolean, p_client_name text, p_child_name text, p_child_age int, p_phone text,
  p_course uuid, p_branches uuid[], p_heard_from text, p_locale text, p_consent_version text, p_dedupe_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid;
  v_course   public.courses%rowtype;
  v_branches uuid[];
  v_names    text;
  v_numbers  int[];
  v_id       uuid;
  v_message  text;
begin
  select id into v_org from public.organizations where slug = p_org_slug and status = 'active';
  if v_org is null then
    raise exception 'organization not available' using errcode = '22023';
  end if;
  if p_consent_version is distinct from app.current_legal_version(v_org, 'privacy') then
    raise exception 'consent version is not current' using errcode = '22023';
  end if;
  select * into v_course from public.courses where id = p_course and organization_id = v_org and status = 'published';
  if v_course.id is null then
    raise exception 'course not available' using errcode = '22023';
  end if;
  select array_agg(b.id order by b.site_number nulls last, b.name), string_agg(b.name, ', ' order by b.site_number nulls last, b.name),
         array_agg(b.site_number order by b.site_number) filter (where b.site_number is not null)
    into v_branches, v_names, v_numbers
  from public.branches b
  where b.organization_id = v_org and b.status = 'active' and b.id = any (coalesce(p_branches, '{}'));
  if v_branches is null or cardinality(v_branches) <> cardinality(array(select distinct unnest(p_branches))) then
    raise exception 'branch not available' using errcode = '22023';
  end if;

  -- Текст для CRM: всё, что человек указал, в одной записи истории.
  v_message := concat_ws(E'\n',
    'Курс: ' || v_course.title,
    'Филиалы: ' || v_names,
    case when p_for_child then 'Для ребёнка: ' || btrim(p_child_name) || ' (' || p_child_age || ')' else 'Для себя' end,
    'Откуда узнали: ' || p_heard_from);

  insert into public.lead_requests (organization_id, branch_id, kind, full_name, phone, message, course_id, locale, consent_version, dedupe_key,
                                    for_child, child_name, child_age, branch_ids, heard_from)
  values (v_org, v_branches[1], 'contact', btrim(p_client_name), nullif(btrim(p_phone), ''), v_message, v_course.id, p_locale, p_consent_version, p_dedupe_key,
          coalesce(p_for_child, false), case when p_for_child then btrim(p_child_name) end, case when p_for_child then p_child_age end,
          v_branches, p_heard_from)
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.lead_requests where dedupe_key = p_dedupe_key;
    return jsonb_build_object('id', v_id, 'duplicate', true);
  end if;
  perform app.crm_intake(v_id);
  return jsonb_build_object('id', v_id, 'duplicate', false, 'courseCode', coalesce(v_course.site_code, v_course.title),
                            'branchNumbers', coalesce(to_jsonb(v_numbers), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Публичные функции (пересоздаются с новыми полями)
-- ---------------------------------------------------------------------------
create or replace function public.public_site(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name', o.name,
    'slug', o.slug,
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'city', b.city, 'address', b.address,
                                          'phone', b.phone, 'email', b.email, 'timezone', b.timezone,
                                          'whatsapp', b.whatsapp, 'number', b.site_number,
                                          'courseIds', coalesce((select jsonb_agg(bc.course_id) from public.branch_courses bc
                                                                  join public.courses c on c.id = bc.course_id and c.status = 'published'
                                                                  where bc.branch_id = b.id), '[]'::jsonb))
                       order by b.site_number nulls last, b.city, b.name)
      from public.branches b where b.organization_id = o.id and b.status = 'active'), '[]'::jsonb),
    'legal', (
      select jsonb_object_agg(k.kind, app.current_legal_version(o.id, k.kind))
      from unnest(array['privacy', 'terms', 'personal_data']) as k(kind)),
    'pages', coalesce((
      select jsonb_agg(distinct p.slug) from public.public_pages p where p.organization_id = o.id and p.status = 'published'), '[]'::jsonb),
    'settings', (select s.content from public.site_settings s where s.organization_id = o.id)
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
    'category', c.category, 'ageNote', c.age_note,
    'language', case when l.id is null then null else jsonb_build_object('code', l.code, 'name', l.name) end,
    'level', case when lv.id is null then null else
      jsonb_build_object('code', lv.code, 'title', lv.title, 'framework', lv.framework, 'order', lv.sort_order) end,
    'price', case when c.public_price is null then null else
      jsonb_build_object('amount', c.public_price::text, 'currency', c.public_price_currency, 'unit', c.public_price_unit) end,
    'branchIds', coalesce((select jsonb_agg(bc.branch_id) from public.branch_courses bc
                            join public.branches b on b.id = bc.branch_id and b.status = 'active'
                            where bc.course_id = c.id), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branchId', g.branch_id, 'branch', b.name, 'city', b.city, 'startsOn', g.starts_on,
        'enrollment', g.enrollment_status,
        'scheduleNote', g.schedule_note,
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
  ) order by c.category nulls last, l.name nulls last, lv.sort_order nulls last, c.title), '[]'::jsonb)
  from public.courses c
  left join public.languages l on l.id = c.language_id
  left join public.course_levels lv on lv.id = c.level_id
  where c.organization_id = app.public_org(p_slug) and c.status = 'published'
    and (c.language_id is null or l.status = 'active');
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS и привилегии
-- ---------------------------------------------------------------------------
alter table public.branch_courses enable row level security;
alter table public.site_settings  enable row level security;

create policy "members read branch courses" on public.branch_courses
  for select to authenticated using (app.is_member(organization_id));
create policy "site managers with mfa add branch courses" on public.branch_courses
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'));
create policy "site managers with mfa remove branch courses" on public.branch_courses
  for delete to authenticated using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'));

create policy "members read site settings" on public.site_settings
  for select to authenticated using (app.is_member(organization_id));
create policy "site managers with mfa create site settings" on public.site_settings
  for insert to authenticated with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage') and updated_by = (select auth.uid()));
create policy "site managers with mfa update site settings" on public.site_settings
  for update to authenticated
  using (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage'))
  with check (app.current_aal() = 'aal2' and app.has_permission(organization_id, null, 'site.manage') and updated_by = (select auth.uid()));

revoke all on public.branch_courses, public.site_settings from anon, authenticated;
grant select, insert, delete on public.branch_courses to authenticated;
grant select, insert on public.site_settings to authenticated;
grant update (content, updated_by) on public.site_settings to authenticated;
grant all on public.branch_courses, public.site_settings to service_role;

-- Новые столбцы курса и филиала меняет тот же, кто меняет курс / филиал (политики прежние).
grant update (category, age_note, site_code) on public.courses to authenticated;
grant update (whatsapp, site_number) on public.branches to authenticated;

revoke all on function public.submit_site_request(text, boolean, text, text, int, text, uuid, uuid[], text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_site_request(text, boolean, text, text, int, text, uuid, uuid[], text, text, text, text) to service_role;
revoke all on function public.public_site(text), public.public_catalog(text) from public;
grant execute on function public.public_site(text), public.public_catalog(text) to anon, authenticated, service_role;

revoke execute on all functions in schema app from public, anon;
