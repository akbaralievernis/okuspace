# Схема базы данных (этапы 2–6)

Источник истины — миграции в [`supabase/migrations`](../../supabase/migrations). Этот документ их описывает, но не заменяет. Концептуальная модель — в [DATA_MODEL.md](../architecture/DATA_MODEL.md).

| Миграция | Содержимое |
|---|---|
| `20261015100000_foundation` | `btree_gist`, приватная схема `app`, триггеры `set_updated_at`, `forbid_mutation` (append-only), `forbid_column_change` (неизменяемые столбцы), `current_aal()` |
| `20261015100100_identity` | RBAC-справочники, организации, филиалы, профили (+ `profile_private`), владельцы платформы, членства, опекунство, приглашения, `audit_logs`, функции прав |
| `20261015100200_catalog_scheduling` | языки, уровни (CEFR), курсы, аудитории, группы, преподаватели групп, записи на курс, занятия |
| `20261015100300_learning` | задания и работы учеников |
| `20261015100400_finance` | счета, платежи и возвраты, распределения, представление `invoice_balances` |
| `20261015100500_account_security` (этап 3) | MFA (`aal2`) для управления ролями, опекунством и организациями; `accept_invitation()`; приглашение директора владельцем платформы; `rate_limits` + `hit_rate_limit()`; `list_my_sessions()`; `consents` (append-only); `audit_logs.subject_profile_id` + чтение событий о себе |
| `20261016100000_public_site` (этап 4) | права `site.manage` / `lead.read` / `lead.manage`; контакты филиалов, публичная цена курса; `teacher_public_profiles` (публикует только сам преподаватель); `public_pages`; `legal_documents` (версии, опубликованная неизменна); `trial_slots`; `lead_requests` + `submit_lead_request()` (только service role); 7 функций `public_*` для анонимного чтения; согласия привязаны к школе и актуальным версиям |
| `20261017100000_lms` (этап 5) | модули, уроки, блоки урока (проверка формы по типу); тесты, вопросы и **отдельная таблица ключей** ответов; назначение тестов группам (окна `opens_at`/`due_at`), пересдачи; попытки и ответы (append-only, идемпотентность); `lesson_progress`; функции `submit_assessment_attempt`, `attempt_review`, `track_lesson`, `course_progress`, `my_editable_courses`, `my_learning_courses`; `public_catalog` дополнен расписанием и преподавателями |
| `20261018100000_schedule_attendance` (этап 6) | право `attendance.manage` (MFA); тема и автор занятия, запрет менять отменённое и переносить проведённое; `lesson_session_changes` (append-only) и `notifications` (уведомления в кабинете, без дублей); `create_session_series`, `session_conflicts`, `schedule_window`; посещаемость: `attendance_events` (append-only), `attendance_records` (одна на «занятие + ученик»), `attendance_record_history` (append-only), `attendance_codes` (только хеш); `mark_attendance`, `open_attendance_code`, `check_in_with_code`, `ingest_attendance_event` (только service role), `confirm_camera_event` |

## 1. Таблицы

**Tenancy и identity**

- `organizations`
- `branches`
- `profiles` (1:1 с `auth.users`)
- `profile_private` (телефон, дата рождения)
- `platform_admins`
- `memberships`
- `guardian_links`
- `invitations` (хранится только SHA-256 токена)
- `roles`, `permissions`, `role_permissions`, `role_grants`

**Обучение и расписание**

- `languages`
- `course_levels`
- `courses`
- `classrooms`
- `groups`
- `group_teachers`
- `enrollments`
- `lesson_sessions`
- `assignments`
- `assignment_submissions`

**Контент курса и оценивание (этап 5)**

- `course_modules`, `lessons`, `lesson_blocks`
- `assessments`, `assessment_questions`, `assessment_answer_keys`
- `group_assessments`, `assessment_retakes`
- `assessment_attempts`, `attempt_answers` (append-only)
- `lesson_progress`

**Расписание и посещаемость (этап 6)**

- `lesson_session_changes` (append-only)
- `notifications`
- `attendance_events`, `attendance_record_history` (append-only)
- `attendance_records`
- `attendance_codes` (без политик: доступ только через функции)

**Финансы:** `invoices`, `payments` (тип `payment` или `refund`), `payment_allocations`; представление `invoice_balances` (`security_invoker`).

**Аудит:** `audit_logs`. Записи добавляются триггерами по изменениям:

- организаций и филиальных членств;
- опекунства;
- приглашений;
- записей на курс;
- оценок работ;
- счетов, платежей и распределений.

### Отложены до своих этапов (осознанно)

| Таблицы | Этап | Причина |
|---|---|---|
| `ai_usage_events` | 7 | Модель расхода зависит от выбранного AI-провайдера |
| `leads`, `lead_events` | 8 | CRM |
| `price_lists`, `tariffs`, `invoice_lines`, `webhook_events`, сторнирование распределений | 9 | Полный модуль финансов и платёжный провайдер |
| `camera_devices`, `occupancy_snapshots`, `attendance_reviews`, `monitoring_policies` | 10 | После юридической проверки |
| `notifications`, `files`, `integrations` | 11 / 5 | Вместе с очередью уведомлений и загрузкой файлов |

## 2. Инварианты, закреплённые в БД

| Правило | Механизм |
|---|---|
| Данные не смешиваются между организациями | `organization_id NOT NULL` + составные FK `(organization_id, branch_id[, id])` + запрет менять эти столбцы (`forbid_column_change`) |
| Директор — на всю организацию; филиальные роли — строго с филиалом | CHECK `memberships_director_scope_check`, `memberships_branch_required_check` |
| Нет дубля активной роли | уникальный индекс `memberships_unique_active_idx` (`NULLS NOT DISTINCT`) |
| Уровень принадлежит языку курса; CEFR — только A1–C2 | составной FK `courses_level_fkey`, CHECK `course_levels_cefr_check` |
| Нет повторной записи в группу; вместимость группы | частичный уникальный индекс + триггер `check_enrollment` с `FOR UPDATE` |
| Нет двойного бронирования преподавателя и аудитории | `EXCLUDE USING gist (… WITH =, period WITH &&) WHERE status <> 'cancelled'` |
| Занятие ведёт только преподаватель группы; аудитория — того же филиала | триггер `check_lesson_session`, составной FK |
| Одна работа на ученика и задание; оценка ≤ `max_score`; ученик не оценивает себя | UNIQUE + триггер `guard_submission` |
| Деньги — `numeric(14,2)`, сумма > 0, валюта ISO 4217 | типы + CHECK |
| Платежи и распределения нельзя изменить или удалить (даже service role); счёт нельзя удалить | триггеры `forbid_mutation` на UPDATE/DELETE/TRUNCATE |
| Возврат ссылается на исходный платёж, имеет причину и не превышает нераспределённый остаток | CHECK + триггер `check_payment` |
| Распределение не превышает ни платёж, ни счёт | триггер `check_allocation` |
| Повторное событие провайдера не создаёт второй платёж | `UNIQUE (provider, provider_ref)` |
| Выставленный счёт только аннулируется (с причиной) | триггер `guard_invoice` |
| Журнал аудита append-only; хеши токенов в него не попадают | триггеры `forbid_mutation`, `audit_row` (`diff - 'token_hash'`) |

## 3. Матрица доступа (RLS)

Обозначения: **R** — чтение, **W** — запись, «охват» — организация целиком или свой филиал.

| Таблица | Ученик | Родитель | Преподаватель | Админ / рук. филиала | Бухгалтер | Директор | Чужая организация |
|---|---|---|---|---|---|---|---|
| `profiles` | R свой + преподаватели своих групп | R ребёнка + его преподавателей | R учеников своих групп | R в охвате (`member.read`) | R в охвате | R вся организация | — |
| `profile_private` | R/W свой | R ребёнка | — | R в охвате | R в охвате | R | — |
| `memberships` | R свои | R свои | R свои | R/W в охвате, только по `role_grants`, **не свои** | R в охвате | R/W (кроме `org_director`) | — |
| `groups`, `lesson_sessions` | R своих групп | R групп ребёнка | R своих групп | R/W в охвате | R | R/W | — |
| `enrollments` | R свои | R ребёнка | R своих групп | R/W в охвате | R | R/W | — |
| `assignments` | R опубликованные своих групп | R опубликованные групп ребёнка | R/W своих групп | рук. филиала: R (`learning.read_all`) | — | R | — |
| `assignment_submissions` | R/W своя (до оценки) | R ребёнка | R + оценка в своих группах | рук. филиала: R | — | R | — |
| `invoices`, `payments`, `payment_allocations` | R свои | R ребёнка | — | рук. филиала: R | R/W в охвате, **только с MFA (aal2)** | R (без записи) | — |
| `audit_logs` | — | — | — | — | — | R | — |
| Справочники RBAC | R | R | R | R | R | R | R |

Владелец платформы (`platform_admins`) управляет организациями: создание, приостановка. Данные школ он через RLS не читает. Записи в `platform_admins` и справочники RBAC делаются только миграциями или через service role.

Роль `anon` не имеет привилегий ни на одну таблицу. Функции схемы `app` для `anon` и `PUBLIC` не исполняемы.

## 4. Функции прав (схема `app`, `SECURITY DEFINER`, `search_path = ''`)

| Функция | Что проверяет |
|---|---|
| `is_platform_admin()` | текущий пользователь — владелец платформы |
| `is_member(org)` | активное членство в активной организации |
| `has_permission(org, branch, perm)` | право через роль. `branch = null` — ресурс уровня организации, подходят только членства без филиала |
| `can_assign_role(org, branch, role)` | `member.manage` + `role_grants` + охват |
| `staff_can(profile, perm)` | право над участником в охвате его членства |
| `is_guardian_of(student)` | активная связь опекунства + активное членство родителя |
| `is_group_teacher` / `is_group_student` / `is_group_guardian` / `can_read_group(group)` | связь с группой |
| `can_see_profile(profile)` | объединение правил видимости профиля |

Все функции работают только относительно `auth.uid()`: узнать с их помощью права другого пользователя нельзя.

## 5. Как проверяется

- `tests/security/*.test.ts`: 248 тестов на PGlite (этап 6) (PostgreSQL 18.3). Перед запуском применяются `tests/db/supabase-shim.sql` и все миграции.
- Решение и ограничения этого подхода — [ADR-0004](../DECISIONS.md).
- Запуск: `npm run test`.

## 6. Публичный доступ (этап 4)

Аноним **не имеет** привилегий на таблицы. Публичный сайт читает данные только через функции:

- `public_site`
- `public_catalog`
- `public_levels`
- `public_teachers`
- `public_trial_slots`
- `public_page`
- `public_legal`

Каждая получает slug школы. Функции возвращают только опубликованные записи активной школы и только безопасные поля: никаких email и id людей. Тесты — `tests/security/public-site.test.ts` и `tests/integration/public-site.test.ts` (совместимость с TS-схемами сайта).

После этапа 4 в схеме 33 таблицы и 83 политики RLS.

## 7. Обучение: контент, тесты, прогресс (этап 5)

**Кто что видит и меняет**

| Действие | Кто |
|---|---|
| Править структуру курса, уроки, тесты | `catalog.manage` в организации или преподаватель группы этого курса (`app.can_edit_course`) |
| Видеть опубликованные уроки и тесты | ученик активной записи на группу курса и его родитель, преподаватель курса, сотрудник с `learning.read_all` |
| Видеть ключи ответов (`assessment_answer_keys`) | только редакторы курса. Ученику таблица недоступна целиком |
| Назначать тест группе, давать пересдачу | преподаватель группы (тест должен быть опубликован и относиться к курсу группы) |
| Отправлять попытку | только сам ученик, через `submit_assessment_attempt` (прямой INSERT закрыт) |
| Видеть попытки и разбор | сам ученик, его родитель, преподаватель группы, сотрудник с правом на результаты (`app.can_view_student_results`) |

**Попытки.** `submit_assessment_attempt(assessment, answers, idempotency_key)`:

- проверяет окно назначения и лимит попыток (`max_attempts` + пересдачи);
- оценивает ответы на сервере по ключам: `gap_fill` даёт частичный балл, текст сравнивается после нормализации;
- записывает попытку сразу с итоговым баллом, потом ответы. Обе таблицы append-only;
- повтор с тем же ключом возвращает ту же попытку, а не создаёт новую. Номер попытки уникален, параллельные отправки сериализуются advisory-блокировкой.

**Показ ответов** (`attempt_review`) зависит от `reveal_answers` теста:

- `never` — ключи и пояснения ученику не показываются;
- `after_submit` — сразу после попытки;
- `after_due` — после срока назначения группы.

Редакторы курса видят ключи всегда. Вопросы и ключи с уже данными ответами менять нельзя (`app.guard_answered_question`), чтобы старые результаты оставались верными.

**Прогресс.** `course_progress` считается из сохранённых строк `lesson_progress` и `assessment_attempts`, отдельного счётчика нет. Завершённый урок повторным открытием не «откатывается».

Тесты — `tests/security/lms.test.ts` (26), включая полный сценарий «запись → урок → тест → разбор → прогресс».

## 8. Расписание и посещаемость (этап 6)

**Занятия.** Двойное бронирование преподавателя и аудитории запрещают EXCLUDE-ограничения (с этапа 2); отменённые занятия слот не занимают. `create_session_series` создаёт серию по дням недели в поясе филиала (`(дата + время) at time zone пояс` — корректно при переходе на летнее время) одной транзакцией: конфликт хотя бы одного занятия откатывает всю серию и называет дату. `session_conflicts` объясняет конфликт: вид (преподаватель / аудитория) и время; название группы — только если она видна вызывающему.

**Изменения и уведомления.** Триггер на `lesson_sessions` пишет каждое изменение времени, аудитории, ссылки, преподавателя или отмену в `lesson_session_changes` и создаёт уведомления ученикам группы, их опекунам и преподавателям (кроме автора). Уникальный `(recipient_id, dedupe_key)` исключает дубли. Об изменениях давно прошедших занятий не уведомляем. Получатель может менять в уведомлении только `read_at` (привилегия на столбец). Отменённое занятие изменить нельзя, проведённое — перенести.

**Посещаемость**

| Источник | Как попадает | Становится отметкой |
|---|---|---|
| Преподаватель | `mark_attendance` с 15 минут до начала до 48 часов после конца | да |
| Сотрудник (`attendance.manage` + MFA) | `mark_attendance` в любое время после начала; изменение существующей отметки — только с причиной | да |
| Код занятия | преподаватель открывает 6-значный код (хранится SHA-256, ≤ 20 минут); ученик вводит `check_in_with_code`, 10 попыток за 10 минут | да, если отметки ещё нет («опоздал» — позже 10 минут) |
| Карта доступа | `ingest_attendance_event` (только service role), повтор по `idempotency_key` игнорируется | да, если отметки ещё нет |
| Камера | `ingest_attendance_event` | **нет**: только событие; отметку создаёт человек через `confirm_camera_event` (запись хранит событие и того, кто подтвердил) |

Прямые INSERT/UPDATE/DELETE отметок пользователям закрыты; удаление отметок и изменение событий и истории запрещены триггерами. Каждая версия отметки (статус, опоздание, причина, источник, автор, причина исправления) — строка `attendance_record_history`. Видят отметки ученик, его опекун, преподаватель группы и сотрудники с `group.read` в охвате.

Тесты — `tests/security/attendance.test.ts` (36).

