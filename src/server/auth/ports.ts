import type { Role } from '@/server/authz/permissions';

/**
 * Порты слоя авторизации. Реализации: Supabase (production) и подделки в unit-тестах.
 * Use cases (use-cases.ts) зависят только от этих интерфейсов.
 */

export type Aal = 'aal1' | 'aal2';

export interface SessionUser {
  id: string;
  email: string | null;
  aal: Aal;
}

/** Нормализованные причины отказа внешнего Auth-сервиса. */
export type AuthFailure =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'weak_password'
  | 'same_password'
  | 'invalid_code'
  | 'link_invalid'
  | 'session_missing'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown';

export type AuthResult<T = void> = { ok: true; value: T } | { ok: false; reason: AuthFailure };

export interface MfaStatus {
  currentLevel: Aal | null;
  nextLevel: Aal | null;
  verifiedFactorIds: string[];
}

export interface AuthGateway {
  getUser(): Promise<SessionUser | null>;
  signUp(input: { email: string; password: string; fullName: string; locale: string; consentVersion: string; emailRedirectTo: string }): Promise<AuthResult>;
  signIn(input: { email: string; password: string }): Promise<AuthResult>;
  signOut(scope: 'local' | 'others' | 'global'): Promise<AuthResult>;
  sendPasswordReset(email: string, redirectTo: string): Promise<AuthResult>;
  updatePassword(password: string): Promise<AuthResult>;
  verifyEmailLink(tokenHash: string, type: EmailLinkType): Promise<AuthResult>;
  mfaStatus(): Promise<AuthResult<MfaStatus>>;
  mfaEnrollTotp(friendlyName: string): Promise<AuthResult<{ factorId: string; qrCode: string; secret: string }>>;
  mfaVerify(factorId: string, code: string): Promise<AuthResult>;
}

export const emailLinkTypes = ['signup', 'recovery', 'invite', 'email', 'email_change'] as const;
export type EmailLinkType = (typeof emailLinkTypes)[number];

export interface MembershipRecord {
  id: string;
  organizationId: string;
  branchId: string | null;
  role: Role;
  status: 'active' | 'blocked' | 'revoked';
}

export type RepoWrite = 'ok' | 'forbidden' | 'conflict' | 'invalid' | 'unavailable';

/** Доступ к данным от имени пользователя (через RLS). */
export interface AccountRepository {
  myMemberships(userId: string): Promise<MembershipRecord[]>;
  isPlatformAdmin(userId: string): Promise<boolean>;
  createInvitation(input: {
    organizationId: string;
    branchId: string | null;
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<RepoWrite>;
  acceptInvitation(token: string): Promise<'ok' | 'invalid' | 'already_member' | 'unauthenticated' | 'unavailable'>;
  setMembershipStatus(membershipId: string, status: 'active' | 'blocked' | 'revoked', reason: string | null): Promise<RepoWrite>;
}

export type RateBucket = 'login_ip' | 'login_email' | 'register_ip' | 'reset_ip' | 'reset_email' | 'invite_user' | 'mfa_user' | 'accept_user';

export interface RateLimiter {
  /** true — запрос разрешён; false — лимит исчерпан. Бросает исключение, если хранилище недоступно. */
  hit(bucket: RateBucket, key: string, limit: number, windowSeconds: number): Promise<boolean>;
}
