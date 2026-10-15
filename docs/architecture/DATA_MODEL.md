# Модель данных (концептуальная)

Статус: **предложение этапа 1**. Точные столбцы, ограничения и RLS-политики появятся в миграциях этапа 2. Здесь зафиксированы сущности, связи и инварианты, по которым будет проверяться непротиворечивость модели.

## 1. Принципы

1. **Tenant = `organization`.** Каждая строка с данными школы содержит `organization_id` (NOT NULL, FK). Данные уровня филиала содержат ещё и `branch_id`. RLS проверяет оба поля.
2. **Пользователь ≠ член организации.** `auth.users` → `profiles` (1:1, личные данные) → `memberships` (роль в организации, при необходимости ограниченная филиалом). Один человек может быть преподавателем в одном филиале и родителем в другом.
3. **Ключи:** `uuid` (`gen_random_uuid()`). Время — `timestamptz` (хранится в UTC). У филиала есть `timezone` (IANA, например `Asia/Bishkek`).
4. **Деньги:** `numeric(14,2)` + `currency char(3)` (ISO 4217, по умолчанию `KGS`). Типы `float` и `real` запрещены.
5. **Статусы** — `text` с `CHECK (status IN (...))`. Postgres `enum` не используем: его сложно менять в миграциях.
6. **Удаление.** Бизнес-сущности архивируются (`archived_at`), а не удаляются. Политика `ON DELETE` для каждого FK указывается явно: `RESTRICT` по умолчанию, `CASCADE` только для чисто зависимых строк (например, варианты ответа вопроса).
7. **Финансы и аудит append-only.** UPDATE и DELETE запрещены триггером и RLS. Исправления оформляются отдельными корректирующими записями.
8. **Сырые события ≠ подтверждённые факты.** `attendance_events` (QR, камера, отметка преподавателя) — это доказательства. `attendance_records` — одна подтверждённая отметка на пару «урок + ученик», с историей изменений.

## 2. Ядро: tenancy и identity

```mermaid
erDiagram
  organizations ||--o{ branches : has
  organizations ||--o{ memberships : grants
  profiles ||--o{ memberships : holds
  branches |o--o{ memberships : "scopes (null = вся организация)"
  profiles ||--o{ guardian_links : "parent"
  profiles ||--o{ guardian_links : "student"
  organizations ||--o{ invitations : issues
  roles ||--o{ role_permissions : grants
  permissions ||--o{ role_permissions : in
  memberships }o--|| roles : "role"
  platform_admins |o--|| profiles : is

  organizations { uuid id PK; text name; text slug UK; text status; boolean ai_enabled; timestamptz created_at }
  branches { uuid id PK; uuid organization_id FK; text name; text city; text timezone; text status }
  profiles { uuid id PK "= auth.users.id"; text full_name; text phone; text locale; date birth_date "nullable, нужно для несовершеннолетних" }
  memberships { uuid id PK; uuid organization_id FK; uuid profile_id FK; uuid branch_id FK "nullable"; text role FK; text status "active|blocked|revoked" }
  roles { text code PK "platform_owner..parent" }
  permissions { text code PK "e.g. finance.payment.create" }
  role_permissions { text role FK; text permission FK }
  guardian_links { uuid organization_id FK; uuid guardian_id FK; uuid student_id FK; text status }
  invitations { uuid id PK; uuid organization_id FK; text email; text role; uuid branch_id; text token_hash; timestamptz expires_at; timestamptz accepted_at }
  platform_admins { uuid profile_id PK }
```

**Роли** (`roles.code`):

| Код | Роль | Охват |
|---|---|---|
| `platform_owner` | Владелец платформы | через `platform_admins`, а не membership |
| `org_director` | Центральный директор | вся организация |
| `branch_manager` | Руководитель филиала | `branch_id` |
| `admin` | Администратор | `branch_id` |
| `sales_manager` | Менеджер по продажам | `branch_id` или вся организация |
| `accountant` | Бухгалтер | `branch_id` или вся организация |
| `teacher` | Преподаватель | только назначенные группы и занятия |
| `student` | Ученик | только свои записи |
| `parent` | Родитель | только связанные ученики (`guardian_links`) |

**Инварианты:**

- membership с `branch_id` ссылается на филиал **той же** организации (составной FK `(organization_id, branch_id)`);
- пользователь не может создать или изменить свой membership — это проверяется политиками RLS и тестом «повышение прав».

## 3. Каталог, обучение, расписание

```mermaid
erDiagram
  organizations ||--o{ languages : offers
  languages ||--o{ course_levels : has
  languages ||--o{ courses : "taught in"
  course_levels ||--o{ courses : "target level"
  courses ||--o{ course_modules : contains
  course_modules ||--o{ lessons : contains
  lessons ||--o{ lesson_materials : uses
  courses ||--o{ groups : "runs as"
  branches ||--o{ groups : hosts
  groups ||--o{ group_teachers : "taught by"
  groups ||--o{ enrollments : has
  profiles ||--o{ enrollments : "student"
  branches ||--o{ classrooms : has
  groups ||--o{ lesson_sessions : schedules
  classrooms |o--o{ lesson_sessions : "room (null = online)"
  lessons |o--o{ lesson_sessions : covers
  lesson_sessions ||--o{ attendance_events : evidence
  lesson_sessions ||--o{ attendance_records : confirmed
  attendance_records ||--o{ attendance_record_history : changes
  lessons ||--o{ assignments : has
  assignments ||--o{ assignment_submissions : receives
  lessons ||--o{ assessments : has
  assessments ||--o{ assessment_questions : has
  assessments ||--o{ assessment_attempts : receives
  enrollments ||--o{ lesson_progress : tracks

  courses { uuid id PK; uuid organization_id FK; uuid language_id FK; uuid level_id FK; text format "online|offline|hybrid"; text kind "group|individual"; int duration_weeks; text status }
  course_levels { uuid id PK; uuid language_id FK; text code "A1..C2 или своё"; int sort_order; text framework "cefr|custom" }
  groups { uuid id PK; uuid organization_id FK; uuid branch_id FK; uuid course_id FK; int capacity; text enrollment_status "open|closed|waitlist"; date starts_on; date ends_on }
  enrollments { uuid id PK; uuid group_id FK; uuid student_id FK; text status "pending|active|paused|completed|cancelled" }
  lesson_sessions { uuid id PK; uuid group_id FK; uuid teacher_id FK; uuid classroom_id FK; tstzrange period; text status "scheduled|moved|cancelled|done"; text online_url }
  attendance_events { uuid id PK; uuid session_id FK; uuid student_id FK "nullable для подсчёта людей"; text source "teacher|qr|card|camera|admin"; text confidence; timestamptz occurred_at }
  attendance_records { uuid session_id FK; uuid student_id FK; text status "present|late|left_early|absent|excused"; text absence_reason; uuid confirmed_by FK }
  assessment_attempts { uuid id PK; uuid assessment_id FK; uuid student_id FK; int attempt_no; text status; numeric score; uuid idempotency_key UK }
```

**Инварианты этапов 5–6 (будут закреплены ограничениями БД):**

- `UNIQUE (group_id, student_id)` в `enrollments` (без отменённых записей) — повторная запись не создаёт дубль.
- `EXCLUDE USING gist (teacher_id WITH =, period WITH &&) WHERE status <> 'cancelled'` — у преподавателя не может быть двух занятий одновременно. Такое же правило для `classroom_id`. Нужно расширение `btree_gist`.
- `UNIQUE (session_id, student_id)` в `attendance_records` — одна отметка на урок. Изменения пишутся в `attendance_record_history`.
- `UNIQUE (assessment_id, student_id, attempt_no)` + `idempotency_key` — повторная отправка формы не создаёт новую попытку.
- Правильные ответы лежат в `assessment_questions.answer_key`. Ученик читает их только через представление/RPC, которое скрывает ключ до момента, разрешённого настройками теста.

## 4. CRM, финансы, сервисные таблицы

```mermaid
erDiagram
  organizations ||--o{ leads : receives
  leads ||--o{ lead_events : history
  leads |o--o| profiles : "converted to"
  organizations ||--o{ price_lists : defines
  price_lists ||--o{ tariffs : contains
  profiles ||--o{ invoices : "billed (payer)"
  invoices ||--o{ invoice_lines : has
  payments ||--o{ payment_allocations : "split into"
  invoices ||--o{ payment_allocations : "paid by"
  payments ||--o{ payments : "refund / reversal of"
  organizations ||--o{ audit_logs : records
  organizations ||--o{ notifications : sends
  organizations ||--o{ files : stores
  organizations ||--o{ ai_usage_events : meters
  organizations ||--o{ integrations : configures
  organizations ||--o{ webhook_events : receives

  leads { uuid id PK; uuid organization_id FK; uuid branch_id FK; text status; text source; uuid assigned_to FK; text dedupe_key UK }
  invoices { uuid id PK; uuid organization_id FK; uuid branch_id FK; text number UK; numeric total; char currency; text status "draft|issued|partially_paid|paid|void" }
  payments { uuid id PK; uuid organization_id FK; uuid branch_id FK; numeric amount; char currency; text kind "payment|refund|adjustment"; uuid reverses_payment_id FK; text reason; text provider_ref UK; uuid created_by FK }
  payment_allocations { uuid payment_id FK; uuid invoice_id FK; numeric amount }
  audit_logs { bigint id PK; uuid organization_id; uuid actor_id; text action; text entity; uuid entity_id; jsonb diff; inet ip; timestamptz at }
  webhook_events { text provider; text event_id; jsonb payload; timestamptz processed_at }
  ai_usage_events { uuid id PK; uuid organization_id FK; uuid profile_id FK; text feature; int input_tokens; int output_tokens; numeric cost; text currency }
  files { uuid id PK; uuid organization_id FK; text bucket; text path; text mime; bigint size; uuid owner_id; text visibility }
```

**Инварианты финансов (этап 9):**

- `payments` и `payment_allocations` — только INSERT;
- `SUM(payment_allocations.amount) <= payments.amount` (проверка в транзакции);
- `UNIQUE (provider, event_id)` в `webhook_events` — повторный webhook не создаёт платёж повторно;
- возврат — отдельная строка `kind='refund'` со ссылкой `reverses_payment_id`.

## 5. Мониторинг аудиторий (этап 10, после юридической проверки)

Таблицы `camera_devices`, `occupancy_snapshots` (только количество, без изображений), `attendance_reviews` (очередь ручной проверки), `monitoring_policies` (срок хранения), `camera_audit_logs`. Событие камеры попадает в `attendance_events` с `source='camera'`. Подтверждённой отметкой без человека оно не становится.

## 6. Проверка непротиворечивости (чек-лист для этапа 2)

- [ ] Каждая таблица с данными школы имеет `organization_id`. Каждая таблица уровня филиала — составной FK на `(organization_id, branch_id)`.
- [ ] Нет таблиц без RLS (проверка запросом к `pg_class.relrowsecurity` в тестах).
- [ ] Нет столбцов `float`/`real`/`money`.
- [ ] Все FK имеют явный `ON DELETE`.
- [ ] Все уникальные бизнес-правила выражены ограничениями, а не только кодом.
