import 'server-only';

import type { AccessContext } from '@/server/auth/session';
import { can } from '@/server/authz/check';

/** Охват финансов пользователя: школы и права (окончательная проверка — RLS и функции БД). */
export function financeScope(ctx: AccessContext) {
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const any = (p: Parameters<typeof can>[1]) => m.some((x) => can(m, p, x.organizationId, x.branchId));
  const orgs = [...new Set(m.filter((x) => can(m, 'finance.read', x.organizationId, x.branchId)).map((x) => x.organizationId))];
  return {
    m,
    orgs,
    canRead: orgs.length > 0,
    canWrite: any('finance.write'),
    canRefund: any('finance.refund'),
    canApprove: any('finance.approve'),
    orgApprover: (org: string) => can(m, 'finance.approve', org, null),
    branchCan: (perm: Parameters<typeof can>[1], org: string, branch: string | null) => can(m, perm, org, branch),
  };
}
