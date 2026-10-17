import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, migrationFiles, rows } from '../db/harness';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
}, 60_000);

describe('migrations', () => {
  it('apply cleanly to an empty database, in order, with valid file names', () => {
    expect(migrationFiles().length).toBeGreaterThanOrEqual(5);
  });

  it('are re-runnable only via new files: applying again fails instead of silently diverging', async () => {
    // CREATE TABLE без IF NOT EXISTS: повторное применение обязано упасть, а не «молча» пропуститься.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { MIGRATIONS_DIR } = await import('../db/harness');
    const first = migrationFiles().find((f) => f.includes('identity'))!;
    await expect(db.exec(readFileSync(join(MIGRATIONS_DIR, first), 'utf8'))).rejects.toThrow(/already exists/);
  });
});

describe('schema invariants (docs/architecture/DATA_MODEL.md §6)', () => {
  it('every table in public has row level security enabled', async () => {
    const tables = await rows<{ relname: string; relrowsecurity: boolean }>(
      db,
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    expect(tables.length).toBeGreaterThan(20);
    expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);
  });

  it('every RLS table has at least one policy (except service-role-only tables)', async () => {
    // Намеренно без политик — доступ только через функции:
    // rate_limits — hit_rate_limit(); attendance_codes — open_attendance_code() / check_in_with_code() (хранится лишь хеш);
    // payment_webhook_events — record_provider_payment() после проверки подписи.
    // occupancy_snapshots / zone_crossings — читаются только функциями мониторинга с записью в журнал.
    // telegram_link_codes — create_telegram_link_code() / link_telegram() (хранится лишь хеш кода).
    const serviceRoleOnly = ['attendance_codes', 'occupancy_snapshots', 'payment_webhook_events', 'rate_limits', 'telegram_link_codes', 'zone_crossings'];
    const missing = await rows<{ relname: string }>(
      db,
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)`,
    );
    expect(missing.map((m) => m.relname).sort()).toEqual(serviceRoleOnly);
  });

  it('no floating point or money columns', async () => {
    const bad = await rows(
      db,
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public' and data_type in ('real', 'double precision', 'money')`,
    );
    expect(bad).toEqual([]);
  });

  it('no timestamp without time zone columns', async () => {
    const bad = await rows(
      db,
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type = 'timestamp without time zone'`,
    );
    expect(bad).toEqual([]);
  });

  it('money amounts are numeric(14,2)', async () => {
    const amounts = await rows<{ table_name: string; column_name: string; numeric_precision: number; numeric_scale: number }>(
      db,
      `select table_name, column_name, numeric_precision, numeric_scale from information_schema.columns
       where table_schema = 'public' and column_name in ('amount', 'total') and table_name not like '%balances'`,
    );
    expect(amounts.map((a) => a.table_name).sort()).toEqual(['expenses', 'invoice_adjustments', 'invoices', 'payment_allocations', 'payments', 'payroll_statements', 'tariffs', 'teacher_rates']);
    for (const a of amounts) expect([a.table_name, a.numeric_precision, a.numeric_scale]).toEqual([a.table_name, 14, 2]);
  });

  it('every foreign key declares an explicit ON DELETE action', async () => {
    const implicit = await rows(
      db,
      `select conrelid::regclass::text as tbl, conname from pg_constraint
       where contype = 'f' and connamespace = 'public'::regnamespace and confdeltype = 'a'`,
    );
    expect(implicit).toEqual([]);
  });

  it('anon has no privileges on any table in public', async () => {
    const grants = await rows(
      db,
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'anon' and table_schema = 'public'`,
    );
    expect(grants).toEqual([]);
  });

  it('authenticated cannot write RBAC reference tables or audit logs directly', async () => {
    const grants = await rows<{ table_name: string; privilege_type: string }>(
      db,
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'authenticated' and table_schema = 'public'
         and table_name in ('roles', 'permissions', 'role_permissions', 'role_grants', 'platform_admins', 'audit_logs')
         and privilege_type <> 'SELECT'`,
    );
    expect(grants).toEqual([]);
  });

  it('security definer functions pin search_path', async () => {
    const unpinned = await rows(
      db,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(unpinned).toEqual([]);
  });

  it('app helper functions are not executable by anon or PUBLIC', async () => {
    const exposed = await rows(
      db,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and (has_function_privilege('anon', p.oid, 'execute'))`,
    );
    expect(exposed).toEqual([]);
  });

  it('every role used by the app has a permission matrix entry or is relationship-based', async () => {
    const roles = await rows<{ code: string; n: number }>(
      db,
      `select r.code, count(rp.permission)::int as n from public.roles r
       left join public.role_permissions rp on rp.role = r.code group by r.code order by r.code`,
    );
    const relationshipBased = ['parent', 'student', 'teacher'];
    for (const r of roles) {
      if (relationshipBased.includes(r.code)) expect(r.n, r.code).toBe(0);
      else expect(r.n, r.code).toBeGreaterThan(0);
    }
  });
});
