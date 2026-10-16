import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { mfaRequiredPermissions, permissions, roleGrants, rolePermissions, roles } from '@/server/authz/permissions';
import { createMigratedDb, rows } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDb();
}, 60_000);

describe('TypeScript RBAC mirror matches the database', () => {
  it('roles', async () => {
    const dbRoles = (await rows<{ code: string }>(db, 'select code from public.roles')).map((r) => r.code).sort();
    expect([...roles].sort()).toEqual(dbRoles);
  });

  it('permissions', async () => {
    const dbPerms = (await rows<{ code: string }>(db, 'select code from public.permissions')).map((r) => r.code).sort();
    expect([...permissions].sort()).toEqual(dbPerms);
  });

  it('role → permission matrix', async () => {
    const pairs = await rows<{ role: string; permission: string }>(db, 'select role, permission from public.role_permissions');
    const fromDb = Object.fromEntries(roles.map((r) => [r, pairs.filter((p) => p.role === r).map((p) => p.permission).sort()]));
    const fromTs = Object.fromEntries(roles.map((r) => [r, [...rolePermissions[r]].sort()]));
    expect(fromTs).toEqual(fromDb);
  });

  it('role → grantable roles (role_grants)', async () => {
    const pairs = await rows<{ granter_role: string; grantable_role: string }>(db, 'select granter_role, grantable_role from public.role_grants');
    const fromDb = Object.fromEntries(roles.map((r) => [r, pairs.filter((p) => p.granter_role === r).map((p) => p.grantable_role).sort()]));
    const fromTs = Object.fromEntries(roles.map((r) => [r, [...roleGrants[r]].sort()]));
    expect(fromTs).toEqual(fromDb);
  });

  it('MFA-gated permissions are enforced by the database (aal2 in policies)', async () => {
    const policies = await rows<{ tablename: string; qual: string | null; with_check: string | null }>(
      db,
      `select tablename, qual, with_check from pg_policies where schemaname = 'public' and tablename in ('memberships', 'invitations', 'payments', 'invoices', 'payment_allocations')`,
    );
    for (const p of policies.filter((x) => (x.with_check ?? '').length > 0)) {
      expect(`${p.tablename}: ${p.with_check}`).toMatch(/aal2|can_assign_role/);
    }
    expect(mfaRequiredPermissions).toEqual(['member.manage', 'finance.write', 'finance.refund', 'site.manage', 'lead.manage', 'attendance.manage', 'ai.manage', 'crm.admin', 'finance.approve']);
  });
});
