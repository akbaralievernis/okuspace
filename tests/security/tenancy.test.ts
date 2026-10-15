import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, GROUP, INVOICE, ORG, PAYMENT, U, createSeededDb } from '../db/fixtures';
import { as, count } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const TENANT_TABLES = [
  'organizations', 'branches', 'memberships', 'courses', 'classrooms', 'groups', 'group_teachers',
  'enrollments', 'lesson_sessions', 'assignments', 'assignment_submissions', 'invoices', 'payments',
] as const;

describe('tenant isolation', () => {
  it.each(TENANT_TABLES)('director of B sees no rows of organization A in %s', async (table) => {
    const column = table === 'organizations' ? 'id' : 'organization_id';
    const n = await as(db, U.directorB, (tx) => count(tx, `select 1 from public.${table} where ${column} = $1`, [ORG.A]));
    expect(n).toBe(0);
  });

  it('director of A sees own organization data (positive control)', async () => {
    const n = await as(db, U.directorA, (tx) => count(tx, 'select 1 from public.groups where organization_id = $1', [ORG.A]));
    expect(n).toBe(3);
  });

  it('a user without memberships sees nothing', async () => {
    for (const table of TENANT_TABLES) {
      const n = await as(db, U.outsider, (tx) => count(tx, `select 1 from public.${table}`));
      expect(n, table).toBe(0);
    }
  });

  it('anonymous requests have no access at all', async () => {
    await expectDenied(as(db, null, (tx) => tx.query('select * from public.organizations')));
    await expectDenied(as(db, null, (tx) => tx.query('select * from public.payments')));
  });
});

describe('identifier substitution (spoofing)', () => {
  it('director of A cannot create a group in organization B', async () => {
    await expectDenied(
      as(db, U.directorA, (tx) =>
        tx.query(
          `insert into public.groups (organization_id, branch_id, course_id, name, capacity, starts_on)
           values ($1, $2, $3, 'spoof', 5, '2026-12-01')`,
          [ORG.B, BRANCH.B1, COURSE.B],
        ),
      ),
    );
  });

  it('cannot attach a branch of organization B to a group of organization A', async () => {
    await expectDenied(
      as(db, U.directorA, (tx) =>
        tx.query(
          `insert into public.groups (organization_id, branch_id, course_id, name, capacity, starts_on)
           values ($1, $2, $3, 'mixed', 5, '2026-12-01')`,
          [ORG.A, BRANCH.B1, COURSE.A],
        ),
      ),
      /foreign key|row-level security/i,
    );
  });

  it('cannot use a course of organization B in organization A', async () => {
    await expectDenied(
      as(db, U.directorA, (tx) =>
        tx.query(
          `insert into public.groups (organization_id, branch_id, course_id, name, capacity, starts_on)
           values ($1, $2, $3, 'foreign-course', 5, '2026-12-01')`,
          [ORG.A, BRANCH.A1, COURSE.B],
        ),
      ),
      /foreign key/i,
    );
  });

  it('cannot move an existing group to another organization or branch', async () => {
    await expectDenied(
      as(db, U.directorA, (tx) => tx.query('update public.groups set organization_id = $1 where id = $2', [ORG.B, GROUP.A1])),
      /immutable|row-level security/i,
    );
    await expectDenied(
      as(db, U.directorA, (tx) => tx.query('update public.groups set branch_id = $1 where id = $2', [BRANCH.A2, GROUP.A1])),
      /immutable/i,
    );
  });

  it('updates addressed by a foreign id silently affect zero rows', async () => {
    const result = await as(db, U.directorB, (tx) =>
      tx.query(`update public.groups set name = 'hijacked' where id = $1`, [GROUP.A1]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it('accountant of B cannot read invoice or payment of A by id', async () => {
    const n = await as(db, U.accountantB, async (tx) =>
      (await count(tx, 'select 1 from public.invoices where id = $1', [INVOICE.A1])) +
      (await count(tx, 'select 1 from public.payments where id = $1', [PAYMENT.A1])),
    );
    expect(n).toBe(0);
  });

  it('suspending an organization cuts off its members', async () => {
    // Приостановка — действие владельца платформы; проверяем последствия внутри одной транзакции.
    const visible = await as(db, U.platform, async (tx) => {
      await tx.query(`update public.organizations set status = 'suspended' where id = $1`, [ORG.B]);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.directorB, role: 'authenticated' })]);
      return count(tx, 'select 1 from public.groups');
    });
    expect(visible).toBe(0);
  });
});
