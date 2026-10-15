# Схема базы данных (этап 2)

Источник истины — миграции в [`supabase/migrations`](../../supabase/migrations). Этот документ их описывает, но не заменяет. Концептуальная модель — в [DATA_MODEL.md](../architecture/DATA_MODEL.md).

| Миграция | Содержимое |
|---|---|
| `20261015100000_foundation` | `btree_gist`, приватная схема `app`, триггеры `set_updated_at`, `forbid_mutation` (append-only), `forbid_column_change` (неизменяемые столбцы), `current_aal()` |
| `20261015100100_identity` | RBAC-справочники, организации, филиалы, профили (+ `profile_private`), владельцы платформы, членства, опекунство, приглашения, `audit_logs`, функции прав |
| `20261015100200_catalog_scheduling` | языки, уровни (CEFR), курсы, аудитории, группы, преподаватели групп, записи на курс, занятия |
| `20261015100300_learning` | задания и работы учеников |
| `20261015100400_finance` | счета, платежи и возвраты, распределения, представление `invoice_balances` |
| `20261015100500_account_security` (этап 3) | MFA (`aal2`) для управления ролями, опекунством и организациями; `accept_invitation()`; приглашение директора владельцем платформы; `rate_limits` + `hit_rate_limit()`; `list_my_sessions()`; `consents` (append-only); `audit_logs.subject_profile_id` + чтение событий о себе |

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
| `course_modules`, `lessons`, `lesson_materials`, `assessments`, `assessment_attempts`, `lesson_progress` | 5 | Структура контента уточняется вместе с LMS |
| `attendance_events`, `attendance_records`, `attendance_record_history` | 6 | Источники посещаемости и правила подтверждения |
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

- `tests/security/*.test.ts`: 118 тестов на PGlite (PostgreSQL 18.3). Перед запуском применяются `tests/db/supabase-shim.sql` и все миграции.
- Решение и ограничения этого подхода — [ADR-0004](../DECISIONS.md).
- Запуск: `npm run test`.
