import 'server-only';

import { logger } from '@/lib/logger';
import type { Role } from '@/server/authz/permissions';
import { createUserClient } from '@/server/supabase/server';

/**
 * Запросы кабинета. Все — от имени пользователя: RLS сама отсекает чужие данные,
 * поэтому здесь нет фильтров «на всякий случай» по организации — они были бы вторым
 * источником истины.
 */

export interface MemberRow {
  id: string;
  organizationId: string;
  organizationName: string;
  branchId: string | null;
  branchName: string | null;
  profileId: string;
  fullName: string;
  role: Role;
  status: 'active' | 'blocked' | 'revoked';
}

async function namesById(table: 'organizations' | 'branches' | 'profiles', column: 'name' | 'full_name', ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const client = await createUserClient();
  const { data, error } = await client.from(table).select(`id, ${column}`).in('id', ids);
  if (error) logger.error('name lookup failed', { table, code: error.code });
  return new Map((data ?? []).map((r) => [r.id as string, (r as Record<string, unknown>)[column] as string]));
}

/** Членства, видимые пользователю (свои — всегда; чужие — в охвате member.read). */
export async function visibleMemberships(filter?: { profileId?: string }): Promise<MemberRow[]> {
  const client = await createUserClient();
  let query = client.from('memberships').select('id, organization_id, branch_id, profile_id, role, status').order('created_at');
  if (filter?.profileId) query = query.eq('profile_id', filter.profileId);
  const { data, error } = await query;
  if (error) {
    logger.error('memberships query failed', { code: error.code });
    return [];
  }
  const rows = data ?? [];
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const [orgs, branches, people] = await Promise.all([
    namesById('organizations', 'name', uniq(rows.map((r) => r.organization_id as string))),
    namesById('branches', 'name', uniq(rows.map((r) => r.branch_id as string | null))),
    namesById('profiles', 'full_name', uniq(rows.map((r) => r.profile_id as string))),
  ]);
  return rows.map((r) => ({
    id: r.id as string,
    organizationId: r.organization_id as string,
    organizationName: orgs.get(r.organization_id as string) ?? '—',
    branchId: (r.branch_id as string | null) ?? null,
    branchName: r.branch_id ? (branches.get(r.branch_id as string) ?? '—') : null,
    profileId: r.profile_id as string,
    fullName: people.get(r.profile_id as string) || '—',
    role: r.role as Role,
    status: r.status as MemberRow['status'],
  }));
}

export interface BranchOption {
  id: string;
  organizationId: string;
  name: string;
}

export async function branchesOf(organizationIds: string[]): Promise<BranchOption[]> {
  if (organizationIds.length === 0) return [];
  const client = await createUserClient();
  const { data, error } = await client.from('branches').select('id, organization_id, name').in('organization_id', organizationIds).eq('status', 'active').order('name');
  if (error) logger.error('branches query failed', { code: error.code });
  return (data ?? []).map((b) => ({ id: b.id as string, organizationId: b.organization_id as string, name: b.name as string }));
}

export interface SessionRow {
  id: string;
  updatedAt: string | null;
  createdAt: string;
  userAgent: string | null;
  ip: string | null;
  aal: string | null;
  isCurrent: boolean;
}

export async function mySessions(): Promise<SessionRow[] | null> {
  const client = await createUserClient();
  const { data, error } = await client.rpc('list_my_sessions');
  if (error) {
    logger.error('list_my_sessions failed', { code: error.code });
    return null;
  }
  return ((data ?? []) as Record<string, unknown>[]).map((s) => ({
    id: s.id as string,
    createdAt: s.created_at as string,
    updatedAt: (s.updated_at as string | null) ?? null,
    userAgent: (s.user_agent as string | null) ?? null,
    ip: (s.ip as string | null) ?? null,
    aal: (s.aal as string | null) ?? null,
    isCurrent: s.is_current === true,
  }));
}

export interface SecurityEvent {
  at: string;
  action: string;
  entity: string;
  changed: string[];
}

/** События аудита о самом пользователе (политика subject_profile_id = auth.uid()). */
export async function mySecurityEvents(userId: string): Promise<SecurityEvent[]> {
  const client = await createUserClient();
  const { data, error } = await client
    .from('audit_logs')
    .select('at, action, entity, diff')
    .eq('subject_profile_id', userId)
    .order('at', { ascending: false })
    .limit(20);
  if (error) {
    logger.error('security events query failed', { code: error.code });
    return [];
  }
  return (data ?? []).map((e) => ({
    at: e.at as string,
    action: e.action as string,
    entity: e.entity as string,
    changed: e.action === 'update' ? Object.keys((e.diff as Record<string, unknown>) ?? {}) : [],
  }));
}
