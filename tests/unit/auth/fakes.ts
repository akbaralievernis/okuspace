import { vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import type { AccountRepository, AuthGateway, MembershipRecord, RateLimiter, SessionUser } from '@/server/auth/ports';
import type { Deps, MemberDeps } from '@/server/auth/use-cases';

export const USER: SessionUser = { id: '00000000-0000-4000-8000-000000000012', email: 'admin@example.test', aal: 'aal2' };
export const ORG = 'a0000000-0000-4000-8000-000000000001';
export const BRANCH_A1 = 'a1000000-0000-4000-8000-000000000001';
export const BRANCH_A2 = 'a2000000-0000-4000-8000-000000000001';

export function fakeGateway(overrides: Partial<AuthGateway> = {}): AuthGateway {
  const ok = { ok: true as const, value: undefined };
  return {
    getUser: vi.fn(async () => USER),
    signUp: vi.fn(async () => ok),
    signIn: vi.fn(async () => ok),
    signOut: vi.fn(async () => ok),
    sendPasswordReset: vi.fn(async () => ok),
    updatePassword: vi.fn(async () => ok),
    verifyEmailLink: vi.fn(async () => ok),
    mfaStatus: vi.fn(async () => ({ ok: true as const, value: { currentLevel: 'aal1' as const, nextLevel: 'aal2' as const, verifiedFactorIds: [] } })),
    mfaEnrollTotp: vi.fn(async () => ({ ok: true as const, value: { factorId: 'f', qrCode: 'data:image/svg+xml;utf-8,<svg/>', secret: 'S' } })),
    mfaVerify: vi.fn(async () => ok),
    ...overrides,
  };
}

/** Лимитер в памяти: считает попытки по (bucket, key). */
export function memoryLimiter(): RateLimiter & { hits: Map<string, number> } {
  const hits = new Map<string, number>();
  return {
    hits,
    hit: vi.fn(async (bucket, key, limit) => {
      const k = `${bucket}|${key}`;
      const n = (hits.get(k) ?? 0) + 1;
      hits.set(k, n);
      return n <= limit;
    }),
  };
}

export const brokenLimiter = (): RateLimiter => ({
  hit: vi.fn(async () => {
    throw new Error('db down');
  }),
});

export function fakeRepo(memberships: MembershipRecord[], overrides: Partial<AccountRepository> = {}): AccountRepository {
  return {
    myMemberships: vi.fn(async () => memberships),
    isPlatformAdmin: vi.fn(async () => false),
    createInvitation: vi.fn(async () => 'ok' as const),
    acceptInvitation: vi.fn(async () => 'ok' as const),
    setMembershipStatus: vi.fn(async () => 'ok' as const),
    ...overrides,
  };
}

export function deps(over: Partial<Deps> = {}): Deps {
  return {
    gateway: fakeGateway(),
    limiter: memoryLimiter(),
    logger: createLogger({ level: 'error', sink: () => {} }),
    appUrl: 'https://okuspace.example.test',
    ip: '203.0.113.7',
    ...over,
  };
}

export function memberDeps(memberships: MembershipRecord[], over: Partial<MemberDeps> = {}): MemberDeps {
  return { ...deps(), repo: fakeRepo(memberships), user: USER, ...over };
}

export const adminA1: MembershipRecord = { id: 'm1', organizationId: ORG, branchId: BRANCH_A1, role: 'admin', status: 'active' };
