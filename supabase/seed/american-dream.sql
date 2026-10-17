-- ============================================================================
-- Данные сайта учебного центра American Dream (Ош): название, филиалы, курсы,
-- какие курсы в каком филиале, содержимое главной страницы.
-- Источник — бриф школы (2026-10-17). Чего в брифе нет, того здесь нет:
-- цены, длительность, фото, преподаватели, WhatsApp филиалов 3–5, ответы FAQ.
--
-- Запуск: SQL Editor Supabase, после миграций. Школа выбирается по slug (ниже).
-- Повторный запуск безопасен: филиалы ищутся по номеру, курсы — по коду, всё обновляется.
-- ============================================================================

do $$
declare
  v_slug text := 'demo';   -- slug школы на сайте (SITE_ORGANIZATION_SLUG); для боевой школы — свой
  v_org  uuid;
  v_lang uuid;
  b      record;
  c      record;
begin
  select id into v_org from public.organizations where slug = v_slug;
  if v_org is null then
    raise exception 'Школа % не найдена: сначала создайте её (или загрузите демо-данные)', v_slug;
  end if;

  update public.organizations set name = 'American Dream' where id = v_org;

  -- Филиалы (номер = id филиала в Telegram-боте школы).
  for b in select * from (values
    (1, 'American Dream OSH (Геологородок)', 'Ош', 'ул. Атабаева 21', '+996990555504'),
    (2, 'Араванская', 'Ош', 'ул. Моминова 21', '+996554836667'),
    (3, 'Араван', 'с. Араван', 'ул. Ленина 18', null),
    (4, 'Кара-Суу', 'г. Кара-Суу', 'ул. Ала-Тоо 87', null),
    (5, 'Жибек-Жолу 10 Адыр', 'Ош', 'ул. Геодезический 40', null)
  ) as x(num, name, city, address, whatsapp) loop
    update public.branches set name = b.name, city = b.city, address = b.address, whatsapp = b.whatsapp, status = 'active'
     where organization_id = v_org and site_number = b.num;
    if not found then
      insert into public.branches (organization_id, name, city, address, whatsapp, site_number)
      values (v_org, b.name, b.city, b.address, b.whatsapp, b.num);
    end if;
  end loop;

  -- Курсы (код = название курса в Telegram-боте школы). Язык и уровень не обязательны.
  select id into v_lang from public.languages where organization_id = v_org and code = 'en';
  for c in select * from (values
    ('English (General)',   'english',   'Английский (General)',            'Разговорный английский для всех уровней', 'с 10 лет и взрослые'),
    ('Kids English',        'english',   'Английский для детей',            'Игровой формат', '5–10 лет'),
    ('IELTS',               'exams',     'IELTS',                           'Подготовка к международному экзамену', null),
    ('TOEFL / Duolingo',    'exams',     'TOEFL и Duolingo English Test',   'Подготовка к экзаменам для поступления за рубеж', null),
    ('ORT',                 'exams',     'Подготовка к ОРТ',                'Математика и геометрия, русский язык, химия и биология', null),
    ('Math',                'school',    'Математика',                      'Школьная и олимпиадная', null),
    ('Russian',             'school',    'Русский язык',                    'Грамотность и разговорная речь; отдельная группа для учителей', null),
    ('Primary',             'school',    'Начальный класс',                 'Подготовка и поддержка младших школьников', null),
    ('Chemistry & Biology', 'school',    'Химия и биология',                'Для школы и ОРТ', null),
    ('Chinese',             'languages', 'Китайский язык',                  null, null),
    ('Korean',              'languages', 'Корейский язык',                  null, null),
    ('Arabic',              'languages', 'Арабский язык',                   null, null),
    ('Turkish',             'languages', 'Турецкий язык',                   null, null),
    ('Coding',              'it',        'Программирование',                'Python, NodeJS для подростков', null),
    ('1C',                  'it',        '1С: Бухгалтерия',                 null, null)
  ) as x(code, category, title, description, age) loop
    update public.courses set title = c.title, description = c.description, category = c.category, age_note = c.age, status = 'published'
     where organization_id = v_org and site_code = c.code;
    if not found then
      insert into public.courses (organization_id, language_id, level_id, title, description, format, kind, duration_weeks, lessons_per_week,
                                  status, category, age_note, site_code)
      values (v_org, case when c.category = 'english' or c.code in ('IELTS', 'TOEFL / Duolingo') then v_lang end, null,
              c.title, c.description, 'offline', 'group', null, null, 'published', c.category, c.age, c.code);
    end if;
  end loop;

  -- Какие курсы ведёт каждый филиал.
  delete from public.branch_courses where organization_id = v_org;
  insert into public.branch_courses (organization_id, branch_id, course_id)
  select v_org, br.id, co.id
  from (values
    (1, array['English (General)', 'IELTS', 'Kids English', 'Math', 'ORT', 'Korean', 'Chinese', '1C', 'Arabic', 'Turkish', 'Chemistry & Biology', 'Coding']),
    (2, array['English (General)', 'Russian', 'Primary', 'Chinese', 'Arabic', 'IELTS']),
    (3, array['English (General)', 'Russian', 'Math']),
    (4, array['English (General)', 'Coding', 'Kids English', 'Korean', 'Chinese', 'Primary']),
    (5, array['English (General)', 'Coding', 'Kids English', 'Primary'])
  ) as x(num, codes)
  join public.branches br on br.organization_id = v_org and br.site_number = x.num
  join public.courses co on co.organization_id = v_org and co.site_code = any (x.codes);

  -- Главная страница: тексты баннера, цифры, преимущества, результаты, клубы, акции, соцсети.
  insert into public.site_settings (organization_id, content)
  values (v_org, $json${
    "logo": "/brand/american-dream-logo.png",
    "hero": {
      "lines": [
        {"ru": "Английский,", "en": "English", "ky": "Мүмкүнчүлүктөрдү"},
        {"ru": "который открывает", "en": "that opens", "ky": "ачкан"},
        {"ru": "возможности", "en": "opportunities", "ky": "англис тили"}
      ],
      "accentLine": 1,
      "subtitle": {
        "ru": "Английский, ОРТ, IELTS, IT и ещё 10+ направлений. 5 филиалов в Оше и области.",
        "en": "English, ORT, IELTS, IT and 10+ more programmes. 5 branches in Osh and the region.",
        "ky": "Англис тили, ЖРТ, IELTS, IT жана дагы 10дон ашык багыт. Ош шаарында жана облусунда 5 филиал."
      },
      "badges": ["ОРТ", "IELTS", "Kids"],
      "photoNote": {"ru": "студенты American Dream", "en": "American Dream students", "ky": "American Dream окуучулары"}
    },
    "stats": [
      {"value": "5", "label": {"ru": "филиалов", "en": "branches", "ky": "филиал"}},
      {"value": "213", "label": {"ru": "баллов — лучший ОРТ", "en": "points — best ORT score", "ky": "балл — эң мыкты ЖРТ"}}
    ],
    "advantages": [
      {"icon": "teacher", "title": {"ru": "Опытные преподаватели", "en": "Experienced teachers", "ky": "Тажрыйбалуу мугалимдер"}},
      {"icon": "group", "title": {"ru": "Малые группы", "en": "Small groups", "ky": "Чакан топтор"}},
      {"icon": "exam", "title": {"ru": "Подготовка к ОРТ и международным экзаменам", "en": "ORT and international exam preparation", "ky": "ЖРТга жана эл аралык экзамендерге даярдоо"}},
      {"icon": "chat", "title": {"ru": "Клубы общения", "en": "Speaking clubs", "ky": "Сүйлөшүү клубдары"}},
      {"icon": "certificate", "title": {"ru": "Сертификат по окончании", "en": "Certificate on completion", "ky": "Бүтүргөндө сертификат"}},
      {"icon": "map", "title": {"ru": "5 филиалов рядом с домом", "en": "5 branches close to home", "ky": "Үйгө жакын 5 филиал"}}
    ],
    "results": [
      {"value": {"ru": "213 баллов", "en": "213 points", "ky": "213 балл"}, "caption": {"ru": "по ОРТ", "en": "in the ORT", "ky": "ЖРТ боюнча"}, "name": {"ru": "Айсезим"}},
      {"value": {"ru": "ТОП-100", "en": "TOP-100", "ky": "ТОП-100"}, "caption": {"ru": "университетов мира", "en": "world universities", "ky": "дүйнөлүк университет"}, "name": {"ru": "Ученица Miss Madina", "en": "A student of Miss Madina", "ky": "Miss Madina'нын окуучусу"}},
      {"value": {"ru": "60 жашта окууга келдим", "ky": "60 жашта окууга келдим", "en": "Started studying at 60"}, "caption": {"ru": "учиться никогда не поздно", "en": "it's never too late to learn", "ky": "окууга эч качан кеч эмес"}, "name": {"ru": "Сабира эжеке"}}
    ],
    "clubs": [
      {"title": {"ru": "Talking Club"}},
      {"title": {"ru": "Movie Club"}},
      {"title": {"ru": "Семинары", "en": "Seminars", "ky": "Семинарлар"}},
      {"title": {"ru": "Graduation"}},
      {"title": {"ru": "Global Next"}, "text": {"ru": "Учёба на английском в Турции", "en": "Studying in English in Türkiye", "ky": "Түркияда англис тилинде окуу"}}
    ],
    "promos": [
      {"ru": "Приведи 3 друзей и получи 1 месяц обучения бесплатно", "en": "Bring 3 friends and get 1 month of classes free", "ky": "3 досуңду алып кел — 1 ай акысыз оку"}
    ],
    "social": {
      "instagram": [
        {"handle": "@americandream.osh", "url": "https://www.instagram.com/americandream.osh/"},
        {"handle": "@test.dream_", "url": "https://www.instagram.com/test.dream_/", "note": {"ru": "ОРТ", "en": "ORT", "ky": "ЖРТ"}}
      ],
      "whatsapp": "+996990555504"
    }
  }$json$::jsonb)
  on conflict (organization_id) do update set content = excluded.content, updated_at = now();

  -- «О школе» — только факты из брифа.
  update public.public_pages set title = 'О школе',
    body = 'American Dream — учебный центр в Оше. Английский, подготовка к ОРТ, IELTS, TOEFL и Duolingo, школьные предметы, китайский, корейский, арабский и турецкий языки, программирование и 1С. 5 филиалов в Оше и области.'
   where organization_id = v_org and slug = 'about' and locale = 'ru';
end $$;
