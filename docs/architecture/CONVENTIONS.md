# Правила именования и миграций

## 1. Код

| Что | Правило | Пример |
|---|---|---|
| Файлы и папки | `kebab-case` | `lesson-sessions.ts` |
| React-компоненты | `PascalCase`, один компонент на файл | `CourseCard.tsx` |
| Функции и переменные | `camelCase`; булевы — `is/has/can…` | `canEditGroup` |
| Типы | `PascalCase`, без префикса `I` | `Enrollment` |
| Zod-схемы | `<Сущность><Действие>Schema` | `EnrollmentCreateSchema` |
| Server Actions | глагол + сущность | `createEnrollment` |
| Коды прав | `<модуль>.<сущность>.<действие>` | `finance.payment.refund` |
| Коды ошибок | `UPPER_SNAKE` из закрытого списка `AppErrorCode` | `FORBIDDEN` |
| Ключи i18n | `<раздел>.<элемент>` в camelCase | `nav.courses` |
| Переменные окружения | `UPPER_SNAKE`; публичные — только с `NEXT_PUBLIC_` | `SUPABASE_SERVICE_ROLE_KEY` |

Импорты идут через алиас `@/` (→ `src/`). Модули из `src/server/**` начинаются с `import 'server-only'`.

## 2. База данных

| Что | Правило |
|---|---|
| Таблицы | `snake_case`, множественное число: `lesson_sessions` |
| Столбцы | `snake_case`; FK — `<сущность>_id`; время — `<событие>_at` (`timestamptz`); даты — `<событие>_on` (`date`) |
| Ограничения | `<таблица>_<столбцы>_{pk,fk,key,check,excl}` |
| Индексы | `<таблица>_<столбцы>_idx` |
| Политики RLS | `"<роль/охват> can <действие> <что>"`, например `"members can read own branch groups"` |
| Функции | `snake_case` с глаголом: `has_permission`, `current_profile_id` |

Обязательные столбцы бизнес-таблиц: `id uuid`, `organization_id`, `created_at timestamptz default now()`, `updated_at` (через триггер), а также `created_by`, где это осмысленно.

## 3. Миграции

1. Инструмент — Supabase CLI. Файлы лежат в `supabase/migrations/<timestamp>_<описание>.sql`.
2. **Только вперёд.** Применённую миграцию не редактируют, исправление оформляется новой миграцией.
3. Каждая миграция:
   - идемпотентна для чистой БД и выполняется в транзакции (по умолчанию в CLI);
   - для каждой новой таблицы содержит `ENABLE ROW LEVEL SECURITY` и политики **в той же миграции**;
   - не содержит данных production и секретов.
4. Разрушающие изменения (DROP, изменение типа, NOT NULL на заполненном столбце) делаются в 2 шага: «добавить, перенести, переключить код» → в следующем релизе «удалить». Обязательна резервная копия и запись в `docs/DECISIONS.md`.
5. Проверка в CI: на чистой БД применяются все миграции, затем `seed.sql` (только тестовые данные), затем тесты RLS.
6. Типы TS генерируются из схемы (`supabase gen types`) в `src/types/database.ts`. Сгенерированный файл вручную не правится.
7. `seed.sql` никогда не применяется в staging и production.

## 4. Git

- Ветки: `main` (защищена, деплой в production), `develop` → staging, `feat/<этап>-<кратко>`.
- Сообщения коммитов — Conventional Commits: `feat(scheduling): …`, `fix(authz): …`.
- PR не сливается без зелёного CI: typecheck, lint, unit, build, e2e, проверка секретов.
