# supabase/

Миграции и тестовые данные Postgres появятся на **этапе 2**. Правила — в [docs/architecture/CONVENTIONS.md](../docs/architecture/CONVENTIONS.md) §3.

- `migrations/` — SQL-миграции, только вперёд, RLS в той же миграции, что и таблица.
- `seed.sql` — только для dev/test, никогда для staging и production.
