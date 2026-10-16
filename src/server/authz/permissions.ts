import 'server-only';

/**
 * Зеркало справочников RBAC из миграции 0002 (public.roles, public.permissions,
 * public.role_permissions). Источник истины — БД; совпадение проверяет
 * tests/security/rbac-mirror.test.ts. Используется серверной проверкой прав (этап 3).
 */
export const roles = [
  'org_director',
  'branch_manager',
  'admin',
  'sales_manager',
  'accountant',
  'teacher',
  'student',
  'parent',
] as const;
export type Role = (typeof roles)[number];

export const permissions = [
  'org.manage',
  'branch.manage',
  'member.read',
  'member.manage',
  'catalog.manage',
  'group.read',
  'group.manage',
  'schedule.manage',
  'enrollment.manage',
  'learning.read_all',
  'finance.read',
  'finance.write',
  'finance.refund',
  'audit.read',
  'site.manage',
  'lead.read',
  'lead.manage',
] as const;
export type Permission = (typeof permissions)[number];

export const rolePermissions: Record<Role, readonly Permission[]> = {
  org_director: [
    'org.manage', 'branch.manage', 'member.read', 'member.manage', 'catalog.manage', 'group.read', 'group.manage',
    'schedule.manage', 'enrollment.manage', 'learning.read_all', 'finance.read', 'audit.read', 'site.manage', 'lead.read', 'lead.manage',
  ],
  branch_manager: [
    'branch.manage', 'member.read', 'member.manage', 'group.read', 'group.manage', 'schedule.manage',
    'enrollment.manage', 'learning.read_all', 'finance.read', 'lead.read', 'lead.manage',
  ],
  admin: ['member.read', 'member.manage', 'group.read', 'group.manage', 'schedule.manage', 'enrollment.manage', 'lead.read', 'lead.manage'],
  sales_manager: ['member.read', 'member.manage', 'group.read', 'enrollment.manage', 'lead.read', 'lead.manage'],
  accountant: ['member.read', 'group.read', 'finance.read', 'finance.write', 'finance.refund'],
  // Права этих ролей определяются связями (группа, запись, опекунство), а не матрицей.
  teacher: [],
  student: [],
  parent: [],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return rolePermissions[role].includes(permission);
}

/** Зеркало public.role_grants: какие роли может выдавать обладатель роли. */
export const roleGrants: Record<Role, readonly Role[]> = {
  org_director: ['branch_manager', 'admin', 'sales_manager', 'accountant', 'teacher', 'student', 'parent'],
  branch_manager: ['admin', 'sales_manager', 'accountant', 'teacher', 'student', 'parent'],
  admin: ['teacher', 'student', 'parent'],
  sales_manager: ['student', 'parent'],
  accountant: [],
  teacher: [],
  student: [],
  parent: [],
};

/** Права, для которых обязателен MFA (aal2) — совпадает с политиками БД (миграции 0005–0006). */
export const mfaRequiredPermissions: readonly Permission[] = ['member.manage', 'finance.write', 'finance.refund', 'site.manage', 'lead.manage'];
