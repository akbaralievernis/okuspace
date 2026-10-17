-- ============================================================================
-- ДЕМО-ДАННЫЕ для показа (вымышленная школа). НЕ для production.
-- Порядок: 1) миграции (supabase/demo/migrations.sql), 2) `npm run demo:users`
-- (создаёт пользователей в Supabase Auth), 3) этот файл в SQL Editor.
-- Пользователи ищутся по email; даты считаются от сегодняшнего дня.
-- Повторный запуск остановится с ошибкой «демо-данные уже загружены».
-- Файл выполняется одним запросом, то есть одной транзакцией: при любой ошибке не сохранится ничего.
-- ============================================================================

create or replace function pg_temp.u(p_email text) returns uuid
language plpgsql stable as $$
declare v uuid;
begin
  select id into v from auth.users where email = p_email;
  if v is null then
    raise exception 'Нет пользователя %: сначала выполните npm run demo:users', p_email;
  end if;
  return v;
end $$;

do $$
begin
  if exists (select 1 from public.organizations where slug = 'demo') then
    raise exception 'Демо-данные уже загружены (школа demo существует)';
  end if;
end $$;

-- Имена в профилях (триггер создал профили при создании пользователей).
update public.profiles p set full_name = v.name, locale = 'ru'
from (values
  ('director@example.com', 'Айгуль Садыкова'),
  ('manager@example.com', 'Бакыт Иманов'),
  ('admin@example.com', 'Нурия Абдыкадырова'),
  ('accountant@example.com', 'Елена Ким'),
  ('sales@example.com', 'Тимур Осмонов'),
  ('teacher@example.com', 'Sarah Johnson'),
  ('teacher2@example.com', 'Азамат Токтогулов'),
  ('student@example.com', 'Айдана Маматова'),
  ('student2@example.com', 'Эрлан Бекович'),
  ('student3@example.com', 'Мээрим Асанова'),
  ('parent@example.com', 'Гульнара Маматова')
) as v(email, name)
where p.id = pg_temp.u(v.email);

-- ---------------------------------------------------------------------------
-- Школа, филиалы, роли
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name, slug) values
  ('de000000-0000-4000-8000-000000000001', 'Okuspace Demo School', 'demo');

insert into public.branches (id, organization_id, name, city, address, phone, email) values
  ('de100000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'Центр', 'Бишкек', 'ул. Примерная, 1', '+996 312 000 001', 'center@example.com'),
  ('de100000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'Ош', 'Ош', 'ул. Демонстрационная, 2', '+996 3222 00 002', 'osh@example.com');

insert into public.memberships (organization_id, branch_id, profile_id, role)
select 'de000000-0000-4000-8000-000000000001', v.branch::uuid, pg_temp.u(v.email), v.role
from (values
  ('director@example.com', null, 'org_director'),
  ('accountant@example.com', null, 'accountant'),
  ('manager@example.com', 'de100000-0000-4000-8000-000000000001', 'branch_manager'),
  ('admin@example.com', 'de100000-0000-4000-8000-000000000001', 'admin'),
  ('sales@example.com', 'de100000-0000-4000-8000-000000000001', 'sales_manager'),
  ('teacher@example.com', 'de100000-0000-4000-8000-000000000001', 'teacher'),
  ('teacher2@example.com', 'de100000-0000-4000-8000-000000000002', 'teacher'),
  ('student@example.com', 'de100000-0000-4000-8000-000000000001', 'student'),
  ('student2@example.com', 'de100000-0000-4000-8000-000000000001', 'student'),
  ('student3@example.com', 'de100000-0000-4000-8000-000000000002', 'student'),
  ('parent@example.com', 'de100000-0000-4000-8000-000000000001', 'parent')
) as v(email, branch, role);

insert into public.guardian_links (organization_id, guardian_id, student_id) values
  ('de000000-0000-4000-8000-000000000001', pg_temp.u('parent@example.com'), pg_temp.u('student@example.com'));

-- ---------------------------------------------------------------------------
-- Каталог: язык, уровни, курсы, аудитории, группы
-- ---------------------------------------------------------------------------
insert into public.languages (id, organization_id, code, name) values
  ('de200000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'en', 'English');

insert into public.course_levels (id, organization_id, language_id, code, title, sort_order) values
  ('de210000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de200000-0000-4000-8000-000000000001', 'A2', 'Elementary', 2),
  ('de210000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de200000-0000-4000-8000-000000000001', 'B1', 'Intermediate', 3);

insert into public.courses (id, organization_id, language_id, level_id, title, description, format, kind, duration_weeks, lessons_per_week, status, public_price, public_price_currency, public_price_unit) values
  ('de220000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de200000-0000-4000-8000-000000000001', 'de210000-0000-4000-8000-000000000001',
   'General English A2', 'Разговорный английский для начинающих: повседневные темы, грамматика, словарь.', 'offline', 'group', 16, 3, 'published', 6000, 'KGS', 'month'),
  ('de220000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de200000-0000-4000-8000-000000000001', 'de210000-0000-4000-8000-000000000002',
   'English B1 Online', 'Онлайн-курс среднего уровня: обсуждения, письмо, подготовка к экзаменам.', 'online', 'group', 20, 2, 'published', 5000, 'KGS', 'month');

insert into public.classrooms (id, organization_id, branch_id, name, capacity) values
  ('de300000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', '101', 12),
  ('de300000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', '102', 10),
  ('de300000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', '201', 12);

insert into public.groups (id, organization_id, branch_id, course_id, name, capacity, starts_on, status) values
  ('de310000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'EN-A2 вечер', 12, current_date - 30, 'active'),
  ('de310000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', 'de220000-0000-4000-8000-000000000002', 'EN-B1 Ош', 10, current_date - 30, 'active');

insert into public.group_teachers (organization_id, branch_id, group_id, teacher_id) values
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de310000-0000-4000-8000-000000000001', pg_temp.u('teacher@example.com')),
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', 'de310000-0000-4000-8000-000000000002', pg_temp.u('teacher2@example.com'));

insert into public.enrollments (organization_id, branch_id, group_id, student_id, status) values
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de310000-0000-4000-8000-000000000001', pg_temp.u('student@example.com'), 'active'),
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de310000-0000-4000-8000-000000000001', pg_temp.u('student2@example.com'), 'active'),
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', 'de310000-0000-4000-8000-000000000002', pg_temp.u('student3@example.com'), 'active');

-- ---------------------------------------------------------------------------
-- Расписание: две недели назад и две недели вперёд (время Бишкека)
-- Группа A2 — пн/ср/пт 18:00–19:30, ауд. 101; группа B1 — вт/чт 17:00–18:30, онлайн.
-- ---------------------------------------------------------------------------
insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period, online_url, status)
select 'de000000-0000-4000-8000-000000000001', g.branch, g.grp, g.teacher, g.room,
       tstzrange((d + g.start_at) at time zone 'Asia/Bishkek', (d + g.start_at + interval '90 minutes') at time zone 'Asia/Bishkek', '[)'),
       g.url,
       case when (d + g.start_at + interval '90 minutes') at time zone 'Asia/Bishkek' < now() then 'done' else 'scheduled' end
from generate_series(current_date - 14, current_date + 14, interval '1 day') as s(day)
cross join lateral (select s.day::date::timestamp as d) dd
cross join lateral (values
  ('de100000-0000-4000-8000-000000000001'::uuid, 'de310000-0000-4000-8000-000000000001'::uuid, pg_temp.u('teacher@example.com'), 'de300000-0000-4000-8000-000000000001'::uuid, null::text, time '18:00', array[1, 3, 5]),
  ('de100000-0000-4000-8000-000000000002'::uuid, 'de310000-0000-4000-8000-000000000002'::uuid, pg_temp.u('teacher2@example.com'), null::uuid, 'https://meet.example.com/demo-b1', time '17:00', array[2, 4])
) as g(branch, grp, teacher, room, url, start_at, days)
where extract(isodow from dd.d)::int = any (g.days);

-- Посещаемость прошедших занятий: в основном присутствовали; у Эрлана два последних пропуска подряд
-- (это создаст предупреждение менеджеру — так работает правило «серия пропусков»).
with past as (
  select s.id, s.branch_id, s.group_id, s.teacher_id,
         row_number() over (partition by s.group_id order by lower(s.period) desc) as rn
  from public.lesson_sessions s
  where s.organization_id = 'de000000-0000-4000-8000-000000000001' and s.status = 'done'
)
insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, minutes_late, absence_reason, source, marked_by)
select 'de000000-0000-4000-8000-000000000001', p.branch_id, p.id, e.student_id,
       case
         when e.student_id = pg_temp.u('student2@example.com') and p.rn <= 2 then 'absent'
         when e.student_id = pg_temp.u('student@example.com') and p.rn = 3 then 'late'
         else 'present'
       end,
       case when e.student_id = pg_temp.u('student@example.com') and p.rn = 3 then 10 end,
       case when e.student_id = pg_temp.u('student2@example.com') and p.rn <= 2 then 'illness' end,
       'teacher', p.teacher_id
from past p
join public.enrollments e on e.group_id = p.group_id and e.status = 'active'
order by p.rn desc;

-- ---------------------------------------------------------------------------
-- Обучение: модули, уроки, тест
-- ---------------------------------------------------------------------------
insert into public.course_modules (id, organization_id, course_id, title, position, status) values
  ('de400000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'Unit 1. Daily life', 1, 'published'),
  ('de400000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'Unit 2. Travel', 2, 'published');

insert into public.lessons (id, organization_id, course_id, module_id, title, position, estimated_minutes, status) values
  ('de410000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de400000-0000-4000-8000-000000000001', 'My day', 1, 30, 'published'),
  ('de410000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de400000-0000-4000-8000-000000000001', 'Present Simple', 2, 40, 'published'),
  ('de410000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de400000-0000-4000-8000-000000000002', 'At the airport', 1, 35, 'published');

insert into public.lesson_blocks (organization_id, course_id, lesson_id, position, type, content) values
  ('de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de410000-0000-4000-8000-000000000001', 1, 'text', '{"body": "Read the text about Aidana''s day. She gets up at 7 o''clock, has breakfast and goes to school. After school she plays volleyball and does her homework."}'),
  ('de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de410000-0000-4000-8000-000000000001', 2, 'vocabulary', '{"items": [{"term": "get up", "meaning": "вставать"}, {"term": "breakfast", "meaning": "завтрак"}, {"term": "homework", "meaning": "домашнее задание"}]}'),
  ('de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de410000-0000-4000-8000-000000000002', 1, 'text', '{"body": "We use Present Simple for habits and routines: I work, she works, they don''t work. Questions: Do you work? Does she work?"}'),
  ('de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de410000-0000-4000-8000-000000000003', 1, 'vocabulary', '{"items": [{"term": "boarding pass", "meaning": "посадочный талон"}, {"term": "gate", "meaning": "выход на посадку"}, {"term": "luggage", "meaning": "багаж"}]}');

insert into public.assessments (id, organization_id, course_id, lesson_id, title, max_attempts, reveal_answers, status) values
  ('de420000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de410000-0000-4000-8000-000000000002', 'Quiz: Present Simple', 2, 'after_submit', 'published');

insert into public.assessment_questions (id, organization_id, course_id, assessment_id, position, type, prompt, options, points, explanation) values
  ('de430000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de420000-0000-4000-8000-000000000001', 1, 'single_choice',
   'She ___ to school every day.', '[{"id":"a","text":"go"},{"id":"b","text":"goes"},{"id":"c","text":"going"}]', 1, 'He/she/it + -s'),
  ('de430000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de420000-0000-4000-8000-000000000001', 2, 'multiple_choice',
   'Choose the correct questions.', '[{"id":"a","text":"Do you like tea?"},{"id":"b","text":"Does he like tea?"},{"id":"c","text":"Does you like tea?"}]', 2, null),
  ('de430000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'de420000-0000-4000-8000-000000000001', 3, 'short_text',
   'Negative form: I ___ (not work) on Sundays.', '[]', 1, null);

insert into public.assessment_answer_keys (question_id, organization_id, key) values
  ('de430000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', '{"option": "b"}'),
  ('de430000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', '{"options": ["a", "b"]}'),
  ('de430000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001', '{"accepted": ["don''t work", "do not work"]}');

insert into public.group_assessments (organization_id, branch_id, group_id, assessment_id, opens_at, due_at, assigned_by) values
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de310000-0000-4000-8000-000000000001', 'de420000-0000-4000-8000-000000000001',
   now() - interval '1 day', now() + interval '7 days', pg_temp.u('teacher@example.com'));

-- Домашние задания: опубликованное (с работами) и ещё одно на неделю вперёд.
insert into public.assignments (id, organization_id, branch_id, group_id, title, instructions, due_at, max_score, status, created_by) values
  ('de440000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de310000-0000-4000-8000-000000000001',
   'Essay: My weekend', 'Напишите 80–100 слов о своих выходных в Past Simple.', now() - interval '2 days', 10, 'published', pg_temp.u('teacher@example.com')),
  ('de440000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de310000-0000-4000-8000-000000000001',
   'Vocabulary: Travel', 'Выучите слова урока «At the airport» и составьте 5 предложений.', now() + interval '5 days', 10, 'published', pg_temp.u('teacher@example.com'));

insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body) values
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de440000-0000-4000-8000-000000000001', pg_temp.u('student@example.com'),
   'Last weekend I visited my grandparents in Kant. We cooked plov together and watched a film. On Sunday I went to the park with my friends.'),
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de440000-0000-4000-8000-000000000001', pg_temp.u('student2@example.com'),
   'On Saturday I play football. On Sunday I read a book.');

update public.assignment_submissions
set status = 'graded', score = 9, feedback = 'Отлично! Обратите внимание на артикли.', graded_at = now(), graded_by = pg_temp.u('teacher@example.com')
where assignment_id = 'de440000-0000-4000-8000-000000000001' and student_id = pg_temp.u('student@example.com');

-- ---------------------------------------------------------------------------
-- Финансы: прайс-лист, счета, оплаты, расходы
-- ---------------------------------------------------------------------------
insert into public.price_lists (id, organization_id, name, valid_from, status, created_by) values
  ('de500000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'Прайс 2026', date_trunc('year', current_date)::date, 'active', pg_temp.u('director@example.com'));

insert into public.tariffs (organization_id, price_list_id, course_id, name, unit, lessons, amount) values
  ('de000000-0000-4000-8000-000000000001', 'de500000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001', 'General English A2 — месяц', 'month', 12, 6000),
  ('de000000-0000-4000-8000-000000000001', 'de500000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000002', 'English B1 Online — месяц', 'month', 8, 5000);

insert into public.invoices (id, organization_id, branch_id, payer_id, number, total, status, due_on, created_by) values
  ('de510000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', pg_temp.u('student@example.com'), 'D-0001', 6000, 'issued', current_date - 10, pg_temp.u('accountant@example.com')),
  ('de510000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', pg_temp.u('student2@example.com'), 'D-0002', 6000, 'issued', current_date - 5, pg_temp.u('accountant@example.com')),
  ('de510000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', pg_temp.u('student3@example.com'), 'D-0003', 5000, 'issued', current_date + 3, pg_temp.u('accountant@example.com'));

insert into public.payments (id, organization_id, branch_id, payer_id, kind, amount, currency, method, received_at, created_by) values
  ('de520000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', pg_temp.u('student@example.com'), 'payment', 6000, 'KGS', 'cash', now() - interval '12 days', pg_temp.u('accountant@example.com')),
  ('de520000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', pg_temp.u('student2@example.com'), 'payment', 2000, 'KGS', 'card', now() - interval '6 days', pg_temp.u('accountant@example.com'));

insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, created_by) values
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de520000-0000-4000-8000-000000000001', 'de510000-0000-4000-8000-000000000001', 6000, pg_temp.u('accountant@example.com')),
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de520000-0000-4000-8000-000000000002', 'de510000-0000-4000-8000-000000000002', 2000, pg_temp.u('accountant@example.com'));

insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, created_by) values
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'rent', 40000, current_date - 15, 'Аренда помещения (демо)', pg_temp.u('accountant@example.com')),
  ('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'supplies', 3500, current_date - 8, 'Учебники и раздаточные материалы (демо)', pg_temp.u('accountant@example.com'));

-- ---------------------------------------------------------------------------
-- CRM: контакты на разных этапах воронки
-- ---------------------------------------------------------------------------
insert into public.crm_contacts (id, organization_id, branch_id, full_name, phone, email, source, stage, note, owner_id, created_by, lost_reason) values
  ('de600000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'Алия Нурланова', '996700000101', null, 'website_contact', 'new', 'Интересуется курсом для подростка', pg_temp.u('sales@example.com'), pg_temp.u('sales@example.com'), null),
  ('de600000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'Данияр Мусаев', '996700000102', 'daniyar@example.com', 'phone', 'contacted', 'Перезвонить вечером', pg_temp.u('sales@example.com'), pg_temp.u('sales@example.com'), null),
  ('de600000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'Жанара Токтосунова', '996700000103', null, 'social', 'offer', 'Пробное прошло хорошо, отправлено предложение', pg_temp.u('sales@example.com'), pg_temp.u('sales@example.com'), null),
  ('de600000-0000-4000-8000-000000000004', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', 'Руслан Алиев', '996700000104', null, 'walk_in', 'lost', null, null, pg_temp.u('director@example.com'), 'Не подошло расписание');

insert into public.crm_events (organization_id, contact_id, kind, channel, body, actor_id) values
  ('de000000-0000-4000-8000-000000000001', 'de600000-0000-4000-8000-000000000002', 'call', 'phone', 'Рассказали о курсах A2 и B1, просит перезвонить вечером.', pg_temp.u('sales@example.com'));

insert into public.crm_reminders (organization_id, contact_id, assignee_id, due_at, note, created_by) values
  ('de000000-0000-4000-8000-000000000001', 'de600000-0000-4000-8000-000000000002', pg_temp.u('sales@example.com'), now() + interval '1 day', 'Перезвонить и записать на пробное', pg_temp.u('sales@example.com'));

-- ---------------------------------------------------------------------------
-- Публичный сайт: страницы, документы, преподаватели, пробные занятия
-- ---------------------------------------------------------------------------
insert into public.public_pages (organization_id, slug, locale, title, body, status) values
  ('de000000-0000-4000-8000-000000000001', 'about', 'ru', 'О школе', 'Okuspace Demo School — демонстрационная языковая школа. Мы учим английскому в Бишкеке и Оше: в группах, онлайн и индивидуально. Все данные на этом сайте вымышлены.', 'published'),
  ('de000000-0000-4000-8000-000000000001', 'about', 'en', 'About us', 'Okuspace Demo School is a demonstration language school. We teach English in Bishkek and Osh: in groups, online and one-to-one. All data on this site is fictional.', 'published'),
  ('de000000-0000-4000-8000-000000000001', 'about', 'ky', 'Мектеп жөнүндө', 'Okuspace Demo School — демонстрациялык тил мектеби. Бишкекте жана Ошто англис тилин үйрөтөбүз. Бул сайттагы бардык маалыматтар ойдон чыгарылган.', 'published'),
  ('de000000-0000-4000-8000-000000000001', 'contacts', 'ru', 'Контакты', 'Бишкек, ул. Примерная, 1. Ош, ул. Демонстрационная, 2. Ежедневно с 9:00 до 20:00.', 'published'),
  ('de000000-0000-4000-8000-000000000001', 'faq', 'ru', 'Частые вопросы', 'Как записаться? Оставьте заявку на пробное занятие на сайте — менеджер свяжется с вами. Сколько длится занятие? 90 минут.', 'published');

insert into public.legal_documents (organization_id, kind, locale, version, title, body, status, published_at)
select 'de000000-0000-4000-8000-000000000001', k.kind, l.locale, to_char(current_date, 'YYYY-MM-DD'), k.title,
       'ДЕМО-ВЕРСИЯ. Этот текст не является юридическим документом и используется только для демонстрации платформы. '
       || 'Перед запуском школы здесь будет документ, подготовленный юристом в соответствии с законодательством Кыргызской Республики.',
       'published', now()
from (values ('privacy', 'Политика конфиденциальности (демо)'), ('terms', 'Пользовательское соглашение (демо)'), ('personal_data', 'Согласие на обработку персональных данных (демо)')) as k(kind, title)
cross join (values ('ru'), ('ky'), ('en')) as l(locale);

-- Опубликовать профиль может только сам преподаватель: публикуем от его имени (claims как у PostgREST).
create or replace function pg_temp.publish_teacher(p_email text, p_name text, p_bio jsonb, p_langs text[]) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_email), 'role', 'authenticated')::text, true);
  insert into public.teacher_public_profiles (organization_id, profile_id, display_name, bio, languages, status)
  values ('de000000-0000-4000-8000-000000000001', pg_temp.u(p_email), p_name, p_bio, p_langs, 'published');
  perform set_config('request.jwt.claims', '', true);
end $$;
select pg_temp.publish_teacher('teacher@example.com', 'Sarah Johnson',
  '{"ru": "Носитель языка, 8 лет преподавания. Разговорный английский и подготовка к IELTS.", "en": "Native speaker, 8 years of teaching. Speaking and IELTS preparation."}', array['en']);
select pg_temp.publish_teacher('teacher2@example.com', 'Азамат Токтогулов',
  '{"ru": "Преподаватель английского, CELTA. Ведёт онлайн-группы среднего уровня.", "en": "English teacher, CELTA. Teaches intermediate online groups."}', array['en', 'ru', 'ky']);

insert into public.trial_slots (organization_id, branch_id, course_id, period, format, capacity, created_by)
select 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001', 'de220000-0000-4000-8000-000000000001',
       tstzrange((d::date + time '16:00') at time zone 'Asia/Bishkek', (d::date + time '17:00') at time zone 'Asia/Bishkek', '[)'),
       'offline', 4, pg_temp.u('manager@example.com')
from generate_series(current_date + 2, current_date + 9, interval '3 days') as d;


-- ---------------------------------------------------------------------------
-- Управление (блок A): задачи директора филиалам и объявление
-- Действуем от имени пользователей (claims как у PostgREST, с MFA) — права проверяют функции БД.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.act_as(p_email text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(p_email), 'role', 'authenticated', 'aal', 'aal2')::text, true);
end $$;

select pg_temp.act_as('director@example.com');
select public.task_create('de000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object('profileId', pg_temp.u('admin@example.com'), 'branchId', 'de100000-0000-4000-8000-000000000001'),
    jsonb_build_object('profileId', pg_temp.u('teacher2@example.com'), 'branchId', 'de100000-0000-4000-8000-000000000002')),
  'Проверить журналы посещаемости за неделю', 'Отметить все прошедшие занятия и сообщить о пропусках родителям.', 'high', now() + interval '2 days');
select public.task_create('de000000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object('profileId', pg_temp.u('manager@example.com'), 'branchId', 'de100000-0000-4000-8000-000000000001')),
  'Подготовить план набора на ноябрь', 'Сколько групп откроем, нужны ли новые преподаватели.', 'normal', now() + interval '5 days');
select public.task_create('de000000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object('profileId', pg_temp.u('accountant@example.com'), 'branchId', null)),
  'Сверить оплаты за месяц', null, 'normal', now() + interval '3 days');
select public.announcement_publish('de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001',
  'Изменение расписания на праздники', 'В праздничные дни занятия группы EN-A2 переносятся. Новое расписание — в разделе «Расписание».',
  array['teacher', 'student', 'parent'], true);
select public.announcement_publish('de000000-0000-4000-8000-000000000001', null,
  'Собрание руководителей в пятницу', 'Собрание в 10:00 онлайн. Подготовьте итоги месяца по своему филиалу.',
  array['branch_manager', 'admin', 'accountant'], false);

-- Администратор взял задачу в работу (без MFA — так работает исполнитель).
select pg_temp.act_as('admin@example.com');
select public.task_transition(t.id, 'start')
from public.staff_tasks t where t.assignee_id = pg_temp.u('admin@example.com') and t.status = 'open';

-- Кабинет учителя (блок B): экзамен с результатами и задание одному ученику.
select pg_temp.act_as('teacher@example.com');
insert into public.group_exams (id, organization_id, branch_id, group_id, title, held_on, max_score, created_by)
values ('de450000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001',
        'de310000-0000-4000-8000-000000000001', 'Speaking exam: Unit 1', current_date - 3, 50, pg_temp.u('teacher@example.com'));
insert into public.exam_results (exam_id, student_id, organization_id, score, absent) values
  ('de450000-0000-4000-8000-000000000001', pg_temp.u('student@example.com'), 'de000000-0000-4000-8000-000000000001', 44, false),
  ('de450000-0000-4000-8000-000000000001', pg_temp.u('student2@example.com'), 'de000000-0000-4000-8000-000000000001', 31, false);
update public.group_exams set status = 'published' where id = 'de450000-0000-4000-8000-000000000001';
select public.assignment_create('de310000-0000-4000-8000-000000000001', 'Работа над ошибками: Past Simple',
  'Повторите правило и сделайте 10 предложений.', now() + interval '4 days', 10, array[pg_temp.u('student2@example.com')]);
select public.report_cards_generate('de310000-0000-4000-8000-000000000001', date_trunc('month', current_date)::date);
select set_config('request.jwt.claims', '', true);

select 'Демо-данные загружены' as result,
       (select count(*) from public.lesson_sessions where organization_id = 'de000000-0000-4000-8000-000000000001') as sessions,
       (select count(*) from public.notifications where organization_id = 'de000000-0000-4000-8000-000000000001') as notifications;
