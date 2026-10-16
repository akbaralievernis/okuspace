/**
 * Позитивный и негативный случай для политик, которые не покрыты сценарными тестами
 * (tenancy / identity / learning / scheduling / finance). Вместе они проверяют все
 * политики из миграций 0002–0005 — см. docs/database/SCHEMA.md §3.
 */
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { ASSIGN, BRANCH, COURSE, GROUP, INVOICE, LANG, LEVEL, ORG, PAYMENT, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, count, type Tx } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const affected = async (actor: string, sql: string, params: unknown[] = []) =>
  (await as(db, actor, (tx) => tx.query(sql, params))).affectedRows;

describe('catalog: languages, course levels, courses', () => {
  const addLanguage = (tx: Tx) => tx.query(`insert into public.languages (organization_id, code, name) values ($1, 'ru', 'Русский')`, [ORG.A]);
  const addLevel = (tx: Tx) =>
    tx.query(`insert into public.course_levels (organization_id, language_id, code, title, sort_order) values ($1, $2, 'B1', 'Intermediate', 3)`, [
      ORG.A, LANG.A,
    ]);
  const addCourse = (tx: Tx) =>
    tx.query(
      `insert into public.courses (organization_id, language_id, level_id, title, format, kind, duration_weeks) values ($1, $2, $3, 'Speaking club', 'online', 'group', 4)`,
      [ORG.A, LANG.A, LEVEL.A],
    );

  it('director (org-wide catalog.manage) can create', async () => {
    for (const op of [addLanguage, addLevel, addCourse]) await expect(as(db, U.directorA, op)).resolves.toBeDefined();
  });

  it('branch-scoped staff, teachers and other organizations cannot create', async () => {
    for (const actor of [U.managerA1, U.adminA1, U.teacherA1, U.directorB]) {
      for (const op of [addLanguage, addLevel, addCourse]) await expectDenied(as(db, actor, op));
    }
  });

  it('only catalog managers can update', async () => {
    expect(await affected(U.directorA, `update public.courses set title = 'General English A1+' where id = $1`, [COURSE.A])).toBe(1);
    expect(await affected(U.managerA1, `update public.courses set title = 'x' where id = $1`, [COURSE.A])).toBe(0);
    expect(await affected(U.adminA1, `update public.languages set name = 'x' where id = $1`, [LANG.A])).toBe(0);
    expect(await affected(U.teacherA1, `update public.course_levels set title = 'x' where id = $1`, [LEVEL.A])).toBe(0);
  });

  it('a non-CEFR code under the cefr framework is rejected', async () => {
    await expectDenied(
      as(db, U.directorA, (tx) =>
        tx.query(`insert into public.course_levels (organization_id, language_id, code, title, sort_order) values ($1, $2, 'D9', 'x', 9)`, [ORG.A, LANG.A]),
      ),
      /course_levels_cefr_check/,
    );
  });
});

describe('classrooms', () => {
  const addRoom = (branch: string) => (tx: Tx) =>
    tx.query(`insert into public.classrooms (organization_id, branch_id, name, capacity) values ($1, $2, 'New room', 8)`, [ORG.A, branch]);

  it('schedulers create rooms in their branch only', async () => {
    await expect(as(db, U.adminA1, addRoom(BRANCH.A1))).resolves.toBeDefined();
    await expectDenied(as(db, U.adminA1, addRoom(BRANCH.A2)));
    await expectDenied(as(db, U.teacherA1, addRoom(BRANCH.A1)));
  });

  it('schedulers update rooms in their branch only', async () => {
    expect(await affected(U.adminA1, `update public.classrooms set capacity = 10 where id = $1`, [ROOM.A1])).toBe(1);
    expect(await affected(U.adminA1, `update public.classrooms set capacity = 10 where id = $1`, [ROOM.A2])).toBe(0);
  });
});

describe('group teachers and enrollments', () => {
  it('group managers remove teachers in their branch only', async () => {
    const sql = `delete from public.group_teachers where group_id = $1`;
    expect(await affected(U.adminA1, sql, [GROUP.A1])).toBe(1);
    expect(await affected(U.teacherA1, sql, [GROUP.A1])).toBe(0);
    expect(await affected(U.adminA1, sql, [GROUP.A2])).toBe(0);
  });

  it('enrollment managers change enrollments in their branch only', async () => {
    const sql = `update public.enrollments set status = 'paused' where student_id = $1`;
    expect(await affected(U.adminA1, sql, [U.studentA1])).toBe(1);
    expect(await affected(U.teacherA1, sql, [U.studentA1])).toBe(0);
    expect(await affected(U.managerA2, sql, [U.studentA1])).toBe(0);
    expect(await affected(U.studentA1, sql, [U.studentA1])).toBe(0);
  });
});

describe('assignments (teacher-owned)', () => {
  const create = (group: string, actor: string) => (tx: Tx) =>
    tx.query(
      `insert into public.assignments (organization_id, branch_id, group_id, title, created_by) values ($1, $2, $3, 'Homework 2', $4)`,
      [ORG.A, BRANCH.A1, group, actor],
    );

  it('only a teacher of the group creates assignments', async () => {
    await expect(as(db, U.teacherA1, create(GROUP.A1, U.teacherA1))).resolves.toBeDefined();
    await expectDenied(as(db, U.teacherA1, create(GROUP.A1b, U.teacherA1)));
    await expectDenied(as(db, U.studentA1, create(GROUP.A1, U.studentA1)));
    await expectDenied(as(db, U.adminA1, create(GROUP.A1, U.adminA1)));
  });

  it('only a teacher of the group updates assignments', async () => {
    const sql = `update public.assignments set status = 'closed' where id = $1`;
    expect(await affected(U.teacherA1, sql, [ASSIGN.A1])).toBe(1);
    expect(await affected(U.teacherA1b, sql, [ASSIGN.A1])).toBe(0);
    expect(await affected(U.directorA, sql, [ASSIGN.A1])).toBe(0);
  });
});

describe('invoices (creation)', () => {
  const create = (actor: string) => (tx: Tx) =>
    tx.query(
      `insert into public.invoices (organization_id, branch_id, payer_id, number, total, created_by) values ($1, $2, $3, 'A-0100', 1200.00, $4)`,
      [ORG.A, BRANCH.A1, U.studentA1, actor],
    );

  it('accountant with MFA creates; others cannot', async () => {
    await expect(as(db, U.accountantA, create(U.accountantA), { aal: 'aal2' })).resolves.toBeDefined();
    await expectDenied(as(db, U.accountantA, create(U.accountantA)));
    await expectDenied(as(db, U.adminA1, create(U.adminA1), { aal: 'aal2' }));
    await expectDenied(as(db, U.accountantB, create(U.accountantB), { aal: 'aal2' }));
  });
});

describe('private profile, guardian links, invitations, organizations, platform admins', () => {
  it('private profile: own row only', async () => {
    expect(await affected(U.studentA1, `update public.profile_private set phone = '+996 555 000 111' where profile_id = $1`, [U.studentA1])).toBe(1);
    expect(await affected(U.studentA1, `update public.profile_private set phone = '+996 555 000 111' where profile_id = $1`, [U.studentA1b])).toBe(0);
    await expectDenied(
      asMfa(db, U.studentA1, async (tx) => {
        await tx.exec('reset role');
        await tx.query('delete from public.profile_private where profile_id = $1', [U.outsider]);
        await tx.exec('set local role authenticated');
        await tx.query(`insert into public.profile_private (profile_id, phone) values ($1, '+996 555 000 222')`, [U.outsider]);
      }),
    );
  });

  it('guardian links: scoped staff revoke, parents cannot', async () => {
    const sql = `update public.guardian_links set status = 'revoked' where guardian_id = $1`;
    expect((await asMfa(db, U.parentA1, (tx) => tx.query(sql, [U.parentA1]))).affectedRows).toBe(0);
    expect((await asMfa(db, U.adminA1, (tx) => tx.query(sql, [U.parentA1]))).affectedRows).toBe(1);
  });

  it('invitations: granters revoke, others cannot', async () => {
    const revokedBy = (actor: string) =>
      asMfa(db, U.adminA1, async (tx) => {
        await tx.query(
          `insert into public.invitations (organization_id, branch_id, email, role, token_hash, expires_at, created_by)
           values ($1, $2, 'r@example.test', 'teacher', encode(sha256('r'::bytea), 'hex'), now() + interval '1 day', $3)`,
          [ORG.A, BRANCH.A1, U.adminA1],
        );
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: actor, role: 'authenticated', aal: 'aal2' })]);
        return (await tx.query(`update public.invitations set revoked_at = now() where email = 'r@example.test'`)).affectedRows;
      });
    expect(await revokedBy(U.adminA1)).toBe(1);
    expect(await revokedBy(U.teacherA1)).toBe(0);
  });

  it('organizations: only platform admins create', async () => {
    const create = (tx: Tx) => tx.query(`insert into public.organizations (name, slug) values ('Новая школа', 'new-school')`);
    await expect(asMfa(db, U.platform, create)).resolves.toBeDefined();
    await expectDenied(asMfa(db, U.directorA, create));
  });

  it('platform admins list is visible to platform admins only', async () => {
    expect(await as(db, U.platform, (tx) => count(tx, 'select 1 from public.platform_admins'))).toBe(1);
    expect(await as(db, U.directorA, (tx) => count(tx, 'select 1 from public.platform_admins'))).toBe(0);
  });

  it('RBAC reference data is readable by any signed-in user', async () => {
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.roles'))).toBe(8);
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.role_permissions'))).toBeGreaterThan(30);
  });
});

describe('read policies not covered by scenario tests', () => {
  const n = (actor: string, sql: string, params: unknown[] = []) => as(db, actor, (tx) => count(tx, sql, params));

  it('RBAC: permissions and role grants are readable', async () => {
    expect(await n(U.studentA1, 'select 1 from public.permissions')).toBe(17);
    expect(await n(U.studentA1, 'select 1 from public.role_grants')).toBeGreaterThan(10);
  });

  it('organizations: director updates own organization, not another', async () => {
    expect(await affected(U.directorA, `update public.organizations set name = 'Школа A+' where id = $1`, [ORG.A])).toBe(1);
    expect(await affected(U.directorB, `update public.organizations set name = 'x' where id = $1`, [ORG.A])).toBe(0);
    expect(await affected(U.adminA1, `update public.organizations set name = 'x' where id = $1`, [ORG.A])).toBe(0);
  });

  it('guardian links: participants and scoped staff read; staff create', async () => {
    expect(await n(U.parentA1, 'select 1 from public.guardian_links')).toBe(1);
    expect(await n(U.studentA1, 'select 1 from public.guardian_links')).toBe(1);
    expect(await n(U.studentA1b, 'select 1 from public.guardian_links')).toBe(0);
    expect(await n(U.adminA1, 'select 1 from public.guardian_links')).toBe(1);
    expect(await n(U.managerA2, 'select 1 from public.guardian_links')).toBe(0);
    await expect(
      asMfa(db, U.adminA1, (tx) =>
        tx.query(`insert into public.guardian_links (organization_id, guardian_id, student_id) values ($1, $2, $3)`, [ORG.A, U.parentA1, U.studentA1b]),
      ),
    ).resolves.toBeDefined();
  });

  it('invitations: visible to role granters only', async () => {
    const visibleTo = (viewer: string) =>
      asMfa(db, U.adminA1, async (tx) => {
        await tx.query(
          `insert into public.invitations (organization_id, branch_id, email, role, token_hash, expires_at, created_by)
           values ($1, $2, 'v@example.test', 'teacher', encode(sha256('v'::bytea), 'hex'), now() + interval '1 day', $3)`,
          [ORG.A, BRANCH.A1, U.adminA1],
        );
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: viewer, role: 'authenticated', aal: 'aal2' })]);
        return count(tx, 'select 1 from public.invitations');
      });
    expect(await visibleTo(U.adminA1)).toBe(1);
    expect(await visibleTo(U.directorA)).toBe(1);
    expect(await visibleTo(U.teacherA1)).toBe(0);
    expect(await visibleTo(U.managerA2)).toBe(0);
  });

  it('catalog and classrooms: readable by members of the organization only', async () => {
    expect(await n(U.studentA1, 'select 1 from public.courses')).toBe(1);
    expect(await n(U.studentA1, 'select 1 from public.languages')).toBe(1);
    expect(await n(U.studentA1, 'select 1 from public.course_levels')).toBe(1);
    expect(await n(U.teacherA1, 'select 1 from public.classrooms')).toBe(3);
    expect(await n(U.studentB, 'select 1 from public.classrooms')).toBe(0);
    expect(await n(U.outsider, 'select 1 from public.courses')).toBe(0);
  });

  it('group teachers and enrollments: related users only', async () => {
    expect(await n(U.studentA1, 'select 1 from public.group_teachers')).toBe(1);
    expect(await n(U.studentA1, 'select 1 from public.enrollments')).toBe(1);
    expect(await n(U.teacherA1, 'select 1 from public.enrollments')).toBe(1);
    expect(await n(U.parentA1, 'select 1 from public.enrollments')).toBe(1);
    expect(await n(U.adminA1, 'select 1 from public.enrollments')).toBe(2);
    expect(await n(U.teacherA2, 'select 1 from public.group_teachers where group_id = $1', [GROUP.A1])).toBe(0);
  });

  it('payment allocations: payer, guardian and finance staff only', async () => {
    const visibleTo = (viewer: string) =>
      as(
        db,
        U.accountantA,
        async (tx) => {
          await tx.query(
            `insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, created_by)
             values ($1, $2, $3, $4, 1000.00, $5)`,
            [ORG.A, BRANCH.A1, PAYMENT.A1, INVOICE.A1, U.accountantA],
          );
          await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: viewer, role: 'authenticated' })]);
          return count(tx, 'select 1 from public.payment_allocations');
        },
        { aal: 'aal2' },
      );
    expect(await visibleTo(U.studentA1)).toBe(1);
    expect(await visibleTo(U.parentA1)).toBe(1);
    expect(await visibleTo(U.accountantA)).toBe(1);
    expect(await visibleTo(U.studentA1b)).toBe(0);
    expect(await visibleTo(U.teacherA1)).toBe(0);
    expect(await visibleTo(U.accountantB)).toBe(0);
  });
});
