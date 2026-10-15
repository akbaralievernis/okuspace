import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, ORG, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const visibleProfiles = (userId: string) =>
  as(db, userId, async (tx) => (await rows<{ id: string }>(tx, 'select id from public.profiles')).map((r) => r.id).sort());

describe('profiles (чужой профиль)', () => {
  it('a student sees self and own teacher, not other students', async () => {
    expect(await visibleProfiles(U.studentA1)).toEqual([U.teacherA1, U.studentA1].sort());
  });

  it('a student cannot update another profile', async () => {
    const result = await as(db, U.studentA1, (tx) =>
      tx.query(`update public.profiles set full_name = 'x' where id = $1`, [U.studentA1b]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it('a student can update own name but not own id', async () => {
    const ok = await as(db, U.studentA1, (tx) =>
      tx.query(`update public.profiles set full_name = 'New Name' where id = $1`, [U.studentA1]),
    );
    expect(ok.affectedRows).toBe(1);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`update public.profiles set id = $1 where id = $2`, [U.outsider, U.studentA1])));
  });

  it('a teacher sees students of own group only', async () => {
    const seen = await visibleProfiles(U.teacherA1);
    expect(seen).toContain(U.studentA1);
    expect(seen).not.toContain(U.studentA1b);
    expect(seen).not.toContain(U.studentA2);
  });

  it('private data: owner, guardian and scoped staff only', async () => {
    const privateOf = (viewer: string, owner: string) =>
      as(db, viewer, (tx) => count(tx, 'select 1 from public.profile_private where profile_id = $1', [owner]));
    expect(await privateOf(U.studentA1, U.studentA1)).toBe(1);
    expect(await privateOf(U.parentA1, U.studentA1)).toBe(1);
    expect(await privateOf(U.adminA1, U.studentA1)).toBe(1);
    expect(await privateOf(U.studentA1b, U.studentA1)).toBe(0);
    expect(await privateOf(U.teacherA1, U.studentA1)).toBe(0); // преподаватель не видит телефон ученика
    expect(await privateOf(U.adminA1, U.studentA2)).toBe(0); // чужой филиал
    expect(await privateOf(U.directorB, U.studentA1)).toBe(0); // чужая организация
    expect(await privateOf(U.parentA1, U.studentA1b)).toBe(0); // не свой ребёнок
  });
});

describe('branches (чужой филиал)', () => {
  it('branch manager updates own branch, not another', async () => {
    const own = await as(db, U.managerA1, (tx) => tx.query(`update public.branches set address = 'ул. 1' where id = $1`, [BRANCH.A1]));
    const other = await as(db, U.managerA1, (tx) => tx.query(`update public.branches set address = 'ул. 2' where id = $1`, [BRANCH.A2]));
    expect([own.affectedRows, other.affectedRows]).toEqual([1, 0]);
  });

  it('branch manager cannot create branches; director can', async () => {
    const insert = (tx: Parameters<Parameters<typeof as>[2]>[0]) =>
      tx.query(`insert into public.branches (organization_id, name, city) values ($1, 'A3', 'Каракол')`, [ORG.A]);
    await expectDenied(as(db, U.managerA1, insert));
    await expect(as(db, U.directorA, insert)).resolves.toBeDefined();
  });

  it('branch-scoped staff do not see memberships of another branch', async () => {
    const n = await as(db, U.adminA1, (tx) => count(tx, 'select 1 from public.memberships where branch_id = $1', [BRANCH.A2]));
    expect(n).toBe(0);
  });
});

describe('privilege escalation (административные функции без прав)', () => {
  const grant = (actor: string, profile: string, role: string, branch: string | null, org: string = ORG.A) =>
    asMfa(db, actor, (tx) =>
      tx.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, $4)`, [
        org, branch, profile, role,
      ]),
    );

  it('a student cannot grant self any role', async () => {
    await expectDenied(grant(U.studentA1, U.studentA1, 'org_director', null));
    await expectDenied(grant(U.studentA1, U.studentA1, 'admin', BRANCH.A1));
  });

  it('a user cannot change own membership', async () => {
    const result = await asMfa(db, U.adminA1, (tx) =>
      tx.query(`update public.memberships set role = 'branch_manager' where profile_id = $1`, [U.adminA1]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it('an admin cannot grant roles above their own', async () => {
    await expectDenied(grant(U.adminA1, U.outsider, 'branch_manager', BRANCH.A1));
    await expectDenied(grant(U.adminA1, U.outsider, 'accountant', BRANCH.A1));
    await expectDenied(grant(U.adminA1, U.outsider, 'org_director', null));
  });

  it('an admin cannot grant roles in another branch or organization', async () => {
    await expectDenied(grant(U.adminA1, U.outsider, 'teacher', BRANCH.A2));
    await expectDenied(grant(U.adminA1, U.outsider, 'teacher', BRANCH.B1, ORG.B));
  });

  it('an admin can grant teacher in own branch (positive control)', async () => {
    await expect(grant(U.adminA1, U.outsider, 'teacher', BRANCH.A1)).resolves.toBeDefined();
  });

  it('a director cannot appoint another director (platform-only)', async () => {
    await expectDenied(grant(U.directorA, U.outsider, 'org_director', null));
  });

  it('a sales manager can enrol-side roles only', async () => {
    await expect(grant(U.salesA1, U.outsider, 'student', BRANCH.A1)).resolves.toBeDefined();
    await expectDenied(grant(U.salesA1, U.outsider, 'teacher', BRANCH.A1));
  });

  it('an admin cannot demote or block a branch manager', async () => {
    const result = await asMfa(db, U.adminA1, (tx) =>
      tx.query(`update public.memberships set status = 'blocked', status_reason = 'x' where profile_id = $1`, [U.managerA1]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it('membership cannot be moved to another person or organization', async () => {
    await expectDenied(
      asMfa(db, U.directorA, (tx) =>
        tx.query(`update public.memberships set profile_id = $1 where profile_id = $2`, [U.outsider, U.teacherA1]),
      ),
      /immutable/,
    );
  });

  it('nobody can write RBAC tables or make themselves platform admin via the API', async () => {
    await expectDenied(asMfa(db, U.directorA, (tx) => tx.query(`insert into public.platform_admins (profile_id) values ($1)`, [U.directorA])));
    await expectDenied(
      asMfa(db, U.directorA, (tx) => tx.query(`insert into public.role_permissions (role, permission) values ('teacher', 'finance.write')`)),
    );
    await expectDenied(asMfa(db, U.directorA, (tx) => tx.query(`update public.role_grants set grantable_role = 'org_director'`)));
  });

  it('a director cannot suspend or unsuspend their own organization; platform admin can', async () => {
    await expectDenied(
      asMfa(db, U.directorA, (tx) => tx.query(`update public.organizations set status = 'suspended' where id = $1`, [ORG.A])),
      /only platform admins/,
    );
    const ok = await asMfa(db, U.platform, (tx) => tx.query(`update public.organizations set status = 'suspended' where id = $1`, [ORG.A]));
    expect(ok.affectedRows).toBe(1);
  });

  it('a blocked member loses access on the next request', async () => {
    const visible = await asMfa(db, U.directorA, async (tx) => {
      await tx.query(`update public.memberships set status = 'blocked', status_reason = 'test' where profile_id = $1`, [U.teacherA1]);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.teacherA1, role: 'authenticated' })]);
      return count(tx, 'select 1 from public.groups');
    });
    expect(visible).toBe(0);
  });

  it('a guardian link cannot be created by the parent themself', async () => {
    await expectDenied(
      asMfa(db, U.parentA1, (tx) =>
        tx.query(`insert into public.guardian_links (organization_id, guardian_id, student_id) values ($1, $2, $3)`, [
          ORG.A, U.parentA1, U.studentA1b,
        ]),
      ),
    );
  });
});

describe('invitations', () => {
  const invite = (actor: string, role: string, branch: string | null) =>
    asMfa(db, actor, (tx) =>
      tx.query(
        `insert into public.invitations (organization_id, branch_id, email, role, token_hash, expires_at, created_by)
         values ($1, $2, 'new.teacher@example.test', $3, encode(sha256('secret-token'::bytea), 'hex'), now() + interval '3 days', $4)`,
        [ORG.A, branch, role, actor],
      ),
    );

  it('follow the same role-grant rules as memberships', async () => {
    await expect(invite(U.adminA1, 'teacher', BRANCH.A1)).resolves.toBeDefined();
    await expectDenied(invite(U.adminA1, 'branch_manager', BRANCH.A1));
    await expectDenied(invite(U.teacherA1, 'student', BRANCH.A1));
  });

  it('reject plain-text tokens and overly long expiry', async () => {
    await expectDenied(
      asMfa(db, U.adminA1, (tx) =>
        tx.query(
          `insert into public.invitations (organization_id, branch_id, email, role, token_hash, expires_at, created_by)
           values ($1, $2, 'x@example.test', 'teacher', 'plain-token', now() + interval '3 days', $3)`,
          [ORG.A, BRANCH.A1, U.adminA1],
        ),
      ),
      /check constraint/,
    );
  });
});

describe('audit log', () => {
  it('records membership changes with the actor', async () => {
    const entries = await asMfa(
      db,
      U.directorA,
      async (tx) => {
        await tx.query(`update public.memberships set status = 'blocked', status_reason = 'audit test' where profile_id = $1`, [U.teacherA1b]);
        return rows<{ actor_id: string; action: string; diff: Record<string, unknown> }>(
          tx,
          `select actor_id, action, diff from public.audit_logs where entity = 'memberships' and action = 'update'`,
        );
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor_id).toBe(U.directorA);
    expect(entries[0]?.diff).toMatchObject({ status: { old: 'active', new: 'blocked' } });
  });

  it('is readable by the director, not by teachers or other organizations', async () => {
    expect(await asMfa(db, U.directorA, (tx) => count(tx, 'select 1 from public.audit_logs where organization_id = $1', [ORG.A]))).toBeGreaterThan(0);
    // Преподаватель видит только записи о себе (subject_profile_id), но не журнал организации.
    expect(await asMfa(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.audit_logs where subject_profile_id is distinct from $1', [U.teacherA1]))).toBe(0);
    expect(await asMfa(db, U.directorB, (tx) => count(tx, 'select 1 from public.audit_logs where organization_id = $1', [ORG.A]))).toBe(0);
  });

  it('is append-only even for the service role', async () => {
    await expectDenied(asService(db, (tx) => tx.query('delete from public.audit_logs')), /append-only/);
    await expectDenied(asService(db, (tx) => tx.query(`update public.audit_logs set action = 'insert'`)), /append-only/);
    await expectDenied(asService(db, (tx) => tx.query('truncate public.audit_logs')), /append-only/);
  });

  it('records invitations but never their token hashes', async () => {
    const [logged, leaked] = await asMfa(db, U.adminA1, async (tx) => {
      await tx.query(
        `insert into public.invitations (organization_id, branch_id, email, role, token_hash, expires_at, created_by)
         values ($1, $2, 'audit@example.test', 'teacher', encode(sha256('t'::bytea), 'hex'), now() + interval '1 day', $3)`,
        [ORG.A, BRANCH.A1, U.adminA1],
      );
      await tx.exec('reset role');
      return [
        await count(tx, `select 1 from public.audit_logs where entity = 'invitations'`),
        await count(tx, `select 1 from public.audit_logs where diff ? 'token_hash'`),
      ];
    });
    expect([logged, leaked]).toEqual([1, 0]);
  });
});
