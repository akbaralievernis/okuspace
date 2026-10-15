import 'server-only';

import { createHash } from 'node:crypto';
import {
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { Role } from '@/server/authz/permissions';
import type {
  AccountRepository,
  AuthFailure,
  AuthGateway,
  AuthResult,
  EmailLinkType,
  MembershipRecord,
  RateBucket,
  RateLimiter,
  RepoWrite,
  SessionUser,
} from './ports';

// ---------------------------------------------------------------------------
// Ошибки Supabase Auth → нормализованные причины
// ---------------------------------------------------------------------------
export function mapAuthError(error: unknown): AuthFailure {
  if (isAuthRetryableFetchError(error)) return 'unavailable';
  if (isAuthSessionMissingError(error)) return 'session_missing';
  if (isAuthApiError(error)) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'invalid_credentials';
      case 'email_not_confirmed':
        return 'email_not_confirmed';
      case 'weak_password':
        return 'weak_password';
      case 'same_password':
        return 'same_password';
      case 'mfa_verification_failed':
      case 'mfa_challenge_expired':
      case 'mfa_factor_not_found':
        return 'invalid_code';
      case 'otp_expired':
      case 'flow_state_expired':
      case 'flow_state_not_found':
      case 'bad_code_verifier':
        return 'link_invalid';
      case 'session_not_found':
      case 'session_expired':
      case 'refresh_token_not_found':
        return 'session_missing';
      case 'over_request_rate_limit':
      case 'over_email_send_rate_limit':
        return 'rate_limited';
      case 'request_timeout':
      case 'hook_timeout':
      case 'hook_timeout_after_retry':
        return 'unavailable';
      default:
        return error.status >= 500 ? 'unavailable' : 'unknown';
    }
  }
  return 'unknown';
}

type SbResponse = { data: unknown; error: unknown };
/** Данные успешной ветки ответа Supabase ({ data, error: null }). */
type Ok<R extends SbResponse> = Extract<R, { error: null }>['data'];

async function attempt<R extends SbResponse>(fn: () => Promise<R>): Promise<AuthResult<Ok<R>>> {
  try {
    const { data, error } = await fn();
    if (error) return { ok: false, reason: mapAuthError(error) };
    return { ok: true, value: data as Ok<R> };
  } catch (error) {
    logger.error('auth gateway call failed', { error });
    return { ok: false, reason: 'unavailable' };
  }
}

const unit = <T>(r: AuthResult<T>): AuthResult => (r.ok ? { ok: true, value: undefined } : r);

// ---------------------------------------------------------------------------
// AuthGateway на Supabase Auth (сессия — в HttpOnly cookie через @supabase/ssr)
// ---------------------------------------------------------------------------
export function createSupabaseGateway(client: SupabaseClient): AuthGateway {
  return {
    async getUser(): Promise<SessionUser | null> {
      try {
        // getUser проверяет JWT на сервере Auth (а не только подпись cookie).
        const { data, error } = await client.auth.getUser();
        if (error || !data.user) return null;
        const aal = await client.auth.mfa.getAuthenticatorAssuranceLevel();
        return {
          id: data.user.id,
          email: data.user.email?.toLowerCase() ?? null,
          aal: aal.data?.currentLevel === 'aal2' ? 'aal2' : 'aal1',
        };
      } catch (error) {
        logger.warn('getUser failed', { error });
        return null;
      }
    },

    signUp: async ({ email, password, fullName, locale, consentVersion, emailRedirectTo }) =>
      unit(
        await attempt(() =>
          client.auth.signUp({
            email,
            password,
            options: { emailRedirectTo, data: { full_name: fullName, locale, consent_version: consentVersion } },
          }),
        ),
      ),

    signIn: async ({ email, password }) => unit(await attempt(() => client.auth.signInWithPassword({ email, password }))),

    signOut: async (scope) => {
      try {
        const { error } = await client.auth.signOut({ scope });
        return error ? { ok: false, reason: mapAuthError(error) } : { ok: true, value: undefined };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    sendPasswordReset: async (email, redirectTo) => unit(await attempt(() => client.auth.resetPasswordForEmail(email, { redirectTo }))),

    updatePassword: async (password) => unit(await attempt(() => client.auth.updateUser({ password }))),

    verifyEmailLink: async (tokenHash: string, type: EmailLinkType) =>
      unit(await attempt(() => client.auth.verifyOtp({ token_hash: tokenHash, type }))),

    mfaStatus: async () => {
      const level = await attempt(() => client.auth.mfa.getAuthenticatorAssuranceLevel());
      if (!level.ok) return level;
      const factors = await attempt(() => client.auth.mfa.listFactors());
      if (!factors.ok) return factors;
      return {
        ok: true,
        value: {
          currentLevel: level.value.currentLevel === 'aal2' ? 'aal2' : level.value.currentLevel === 'aal1' ? 'aal1' : null,
          nextLevel: level.value.nextLevel === 'aal2' ? 'aal2' : level.value.nextLevel === 'aal1' ? 'aal1' : null,
          verifiedFactorIds: factors.value.totp.filter((f) => f.status === 'verified').map((f) => f.id),
        },
      };
    },

    mfaEnrollTotp: async (friendlyName) => {
      const r = await attempt(() => client.auth.mfa.enroll({ factorType: 'totp', friendlyName }));
      if (!r.ok) return r;
      if (r.value.type !== 'totp') return { ok: false, reason: 'unknown' };
      return { ok: true, value: { factorId: r.value.id, qrCode: r.value.totp.qr_code, secret: r.value.totp.secret } };
    },

    mfaVerify: async (factorId, code) => unit(await attempt(() => client.auth.mfa.challengeAndVerify({ factorId, code }))),
  };
}

// ---------------------------------------------------------------------------
// AccountRepository: все запросы от имени пользователя → RLS решает окончательно
// ---------------------------------------------------------------------------
function mapWrite(error: { code?: string } | null): RepoWrite {
  if (!error) return 'ok';
  if (error.code === '42501') return 'forbidden'; // RLS / привилегии
  if (error.code === '23505') return 'conflict';
  if (error.code?.startsWith('23') || error.code === '22023') return 'invalid';
  logger.error('database write failed', { code: error.code });
  return 'unavailable';
}

export function createSupabaseRepository(client: SupabaseClient): AccountRepository {
  return {
    async myMemberships(userId) {
      const { data, error } = await client
        .from('memberships')
        .select('id, organization_id, branch_id, role, status')
        .eq('profile_id', userId)
        .eq('status', 'active');
      if (error) {
        logger.error('memberships query failed', { code: error.code });
        return [];
      }
      return (data ?? []).map(
        (m): MembershipRecord => ({
          id: m.id as string,
          organizationId: m.organization_id as string,
          branchId: (m.branch_id as string | null) ?? null,
          role: m.role as Role,
          status: m.status as MembershipRecord['status'],
        }),
      );
    },

    async isPlatformAdmin(userId) {
      const { data, error } = await client.from('platform_admins').select('profile_id').eq('profile_id', userId).maybeSingle();
      return !error && data !== null;
    },

    async createInvitation(input) {
      const { error } = await client.from('invitations').insert({
        organization_id: input.organizationId,
        branch_id: input.branchId,
        email: input.email,
        role: input.role,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt.toISOString(),
        created_by: input.createdBy,
      });
      return mapWrite(error);
    },

    async acceptInvitation(token) {
      const { error } = await client.rpc('accept_invitation', { p_token: token });
      if (!error) return 'ok';
      if (error.code === '22023') return 'invalid';
      if (error.code === '23505') return 'already_member';
      if (error.code === '42501') return 'unauthenticated';
      logger.error('accept_invitation failed', { code: error.code });
      return 'unavailable';
    },

    async setMembershipStatus(membershipId, status, reason) {
      // RLS: невидимая/чужая строка даёт 0 обновлённых строк — это «forbidden».
      const { data, error } = await client
        .from('memberships')
        .update({ status, status_reason: reason })
        .eq('id', membershipId)
        .select('id');
      if (error) return mapWrite(error);
      return data && data.length === 1 ? 'ok' : 'forbidden';
    },
  };
}

// ---------------------------------------------------------------------------
// RateLimiter на public.hit_rate_limit (только service role)
// ---------------------------------------------------------------------------
export function rateLimitBucket(bucket: RateBucket, key: string): string {
  return `${bucket}:${createHash('sha256').update(`${bucket}\u0000${key.toLowerCase()}`, 'utf8').digest('hex')}`;
}

export function createSupabaseRateLimiter(privileged: SupabaseClient): RateLimiter {
  return {
    async hit(bucket, key, limit, windowSeconds) {
      const { data, error } = await privileged.rpc('hit_rate_limit', {
        p_bucket: rateLimitBucket(bucket, key),
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw new Error(`rate limiter failed: ${error.code ?? 'unknown'}`);
      return data === true;
    },
  };
}
