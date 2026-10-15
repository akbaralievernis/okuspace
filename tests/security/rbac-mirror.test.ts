import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissions, rolePermissions, roles } from '@/server/authz/permissions';
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
});
