import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/auth/safe-redirect';
import type { MembershipRecord } from '@/server/auth/ports';
import { mapAuthError, rateLimitBucket } from '@/server/auth/supabase-adapters';
import { assignableRoles, can, canAssignRole, requiresMfa } from '@/server/authz/check';
import { BRANCH_A1, BRANCH_A2, ORG, adminA1 } from './fakes';

const OTHER_ORG = 'b0000000-0000-4000-8000-000000000001';
const m = (role: MembershipRecord['role'], branchId: string | null, status: MembershipRecord['status'] = 'active'): MembershipRecord => ({
  id: `${role}-${branchId}`,
  organizationId: ORG,
  branchId,
  role,
  status,
});

describe('can (mirror of app.has_permission)', () => {
  it('branch-scoped roles act only in their branch; org-wide roles everywhere in the org', () => {
    expect(can([adminA1], 'group.manage', ORG, BRANCH_A1)).toBe(true);
    expect(can([adminA1], 'group.manage', ORG, BRANCH_A2)).toBe(false);
    expect(can([adminA1], 'group.manage', ORG, null)).toBe(false);
    expect(can([m('org_director', null)], 'group.manage', ORG, BRANCH_A2)).toBe(true);
    expect(can([m('org_director', null)], 'group.manage', OTHER_ORG, null)).toBe(false);
  });

  it('ignores blocked memberships and roles without the permission', () => {
    expect(can([m('admin', BRANCH_A1, 'blocked')], 'group.manage', ORG, BRANCH_A1)).toBe(false);
    expect(can([m('teacher', BRANCH_A1)], 'group.manage', ORG, BRANCH_A1)).toBe(false);
    expect(can([m('org_director', null)], 'finance.write', ORG, BRANCH_A1)).toBe(false);
  });
});

describe('role assignment', () => {
  it('follows role_grants and scope; nobody grants org_director', () => {
    expect(canAssignRole([adminA1], 'teacher', ORG, BRANCH_A1)).toBe(true);
    expect(canAssignRole([adminA1], 'branch_manager', ORG, BRANCH_A1)).toBe(false);
    expect(canAssignRole([adminA1], 'teacher', ORG, BRANCH_A2)).toBe(false);
    expect(canAssignRole([m('org_director', null)], 'org_director', ORG, null)).toBe(false);
    expect(canAssignRole([m('accountant', null)], 'student', ORG, BRANCH_A1)).toBe(false);
  });

  it('lists assignable roles for the dropdown', () => {
    expect(assignableRoles([adminA1], ORG, BRANCH_A1).sort()).toEqual(['parent', 'student', 'teacher']);
    expect(assignableRoles([adminA1], ORG, BRANCH_A2)).toEqual([]);
  });
});

describe('MFA requirement', () => {
  it.each([
    ['org_director', null, true],
    ['branch_manager', BRANCH_A1, true],
    ['admin', BRANCH_A1, true],
    ['sales_manager', BRANCH_A1, true],
    ['accountant', null, true],
    ['teacher', BRANCH_A1, false],
    ['student', BRANCH_A1, false],
    ['parent', BRANCH_A1, false],
  ] as const)('%s → %s', (role, branch, expected) => {
    expect(requiresMfa([m(role, branch)], false)).toBe(expected);
  });

  it('platform owners always need MFA', () => {
    expect(requiresMfa([], true)).toBe(true);
  });
});

describe('safeNext', () => {
  it('keeps in-app paths with query strings', () => {
    expect(safeNext('/en/app/members?tab=staff', 'ru')).toBe('/en/app/members?tab=staff');
  });

  it.each([undefined, '', 'app', '//evil.com', '/\\evil.com', 'https://evil.com', '/%0d%0aSet-Cookie:x', '/xx/app', '/ru\u0000/app', '/' + 'a'.repeat(600)])(
    'falls back for %j',
    (value) => {
      expect(safeNext(value, 'ru')).toBe('/ru/app');
    },
  );
});

describe('Supabase adapters', () => {
  it('maps Auth errors without leaking internals', () => {
    expect(mapAuthError(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'))).toBe('invalid_credentials');
    expect(mapAuthError(new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'))).toBe('email_not_confirmed');
    expect(mapAuthError(new AuthApiError('Too many', 429, 'over_request_rate_limit'))).toBe('rate_limited');
    expect(mapAuthError(new AuthApiError('boom', 500, 'unexpected_failure'))).toBe('unavailable');
    expect(mapAuthError(new AuthRetryableFetchError('fetch failed', 0))).toBe('unavailable');
    expect(mapAuthError(new AuthSessionMissingError())).toBe('session_missing');
    expect(mapAuthError(new Error('weird'))).toBe('unknown');
  });

  it('rate-limit buckets hash identifiers and match the database format', () => {
    const bucket = rateLimitBucket('login_email', 'Someone@Example.test');
    expect(bucket).toMatch(/^login_email:[0-9a-f]{64}$/);
    expect(bucket).not.toContain('someone');
    expect(rateLimitBucket('login_email', 'someone@example.test')).toBe(bucket);
    expect(rateLimitBucket('login_ip', 'someone@example.test')).not.toBe(bucket.replace('login_email', 'login_ip'));
  });
});
