import type { MembershipRecord } from '@/server/auth/ports';
import { mfaRequiredPermissions, roleGrants, rolePermissions, type Permission, type Role } from './permissions';

/**
 * Серверная проверка прав для понятных ошибок и построения интерфейса.
 * Повторяет app.has_permission / app.can_assign_role; окончательное решение — за RLS.
 */
export function can(memberships: readonly MembershipRecord[], permission: Permission, orgId: string, branchId: string | null): boolean {
  return memberships.some(
    (m) =>
      m.status === 'active' &&
      m.organizationId === orgId &&
      (m.branchId === null || m.branchId === branchId) &&
      rolePermissions[m.role].includes(permission),
  );
}

export function canAssignRole(memberships: readonly MembershipRecord[], role: Role, orgId: string, branchId: string | null): boolean {
  if (role === 'org_director') return false; // только владелец платформы
  return memberships.some(
    (m) =>
      m.status === 'active' &&
      m.organizationId === orgId &&
      (m.branchId === null || m.branchId === branchId) &&
      rolePermissions[m.role].includes('member.manage') &&
      roleGrants[m.role].includes(role),
  );
}

/** Роли, которые пользователь может выдать в охвате (для выпадающего списка). */
export function assignableRoles(memberships: readonly MembershipRecord[], orgId: string, branchId: string | null): Role[] {
  const all = new Set<Role>();
  for (const m of memberships) {
    if (m.status !== 'active' || m.organizationId !== orgId) continue;
    if (!(m.branchId === null || m.branchId === branchId)) continue;
    if (!rolePermissions[m.role].includes('member.manage')) continue;
    for (const r of roleGrants[m.role]) all.add(r);
  }
  return [...all];
}

/** Нужен ли MFA пользователю: владелец платформы или есть право из mfaRequiredPermissions. */
export function requiresMfa(memberships: readonly MembershipRecord[], isPlatformAdmin: boolean): boolean {
  if (isPlatformAdmin) return true;
  return memberships.some(
    (m) => m.status === 'active' && mfaRequiredPermissions.some((p) => rolePermissions[m.role].includes(p)),
  );
}
