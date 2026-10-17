import { createHash, randomBytes } from 'node:crypto';
import type { Locale } from '@/i18n/config';
import {
  ForgotPasswordSchema,
  InviteSchema,
  LoginSchema,
  MembershipStatusSchema,
  MfaCodeSchema,
  RegisterSchema,
  ResetPasswordSchema,
  fieldErrors,
  type FieldErrorCode,
} from '@/lib/auth/schemas';
import { safeNext } from '@/lib/auth/safe-redirect';
import type { Logger } from '@/lib/logger';
import { canAssignRole } from '@/server/authz/check';
import { emailLinkTypes, type AccountRepository, type AuthGateway, type RateLimiter, type SessionUser } from './ports';

export type FormErrorCode =
  | 'validation'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_code'
  | 'session_expired'
  | 'mfa_required'
  | 'forbidden'
  | 'invalid_invitation'
  | 'already_member'
  | 'weak_password'
  | 'same_password'
  | 'link_invalid'
  | 'registration_closed'
  | 'slot_unavailable'
  | 'slot_full'
  | 'stale_form'
  | 'no_attempts_left'
  | 'schedule_conflict'
  | 'ai_disabled'
  | 'ai_unavailable'
  | 'ai_timeout'
  | 'ai_rate_limited'
  | 'ai_daily_limit'
  | 'ai_budget'
  | 'ai_refused'
  | 'ai_invalid_output'
  | 'ai_input_too_long'
  | 'period_closed'
  | 'amount_exceeds'
  | 'pending_discounts';

export type SuccessCode =
  | 'check_email'
  | 'password_updated'
  | 'signed_out_others'
  | 'invited'
  | 'status_changed'
  | 'mfa_enabled'
  | 'request_received'
  | 'saved'
  | 'sessions_created'
  | 'attendance_saved'
  | 'code_opened'
  | 'checked_in'
  | 'practice_checked'
  | 'imported'
  | 'device_created'
  | 'checked'
  | 'telegram_code';

export type FormState =
  | { status: 'idle' }
  | { status: 'error'; code: FormErrorCode; fieldErrors?: Record<string, FieldErrorCode[]>; data?: Record<string, string> }
  | { status: 'success'; code: SuccessCode; data?: Record<string, string> };

/** Итог use case: состояние формы или перенаправление. */
export type Outcome = { kind: 'state'; state: FormState } | { kind: 'redirect'; to: string };

const state = (s: FormState): Outcome => ({ kind: 'state', state: s });
const fail = (code: FormErrorCode, extra?: Partial<Extract<FormState, { status: 'error' }>>): Outcome =>
  state({ status: 'error', code, ...extra });
const done = (code: SuccessCode, data?: Record<string, string>): Outcome => state({ status: 'success', code, ...(data ? { data } : {}) });

export interface Deps {
  gateway: AuthGateway;
  limiter: RateLimiter;
  logger: Logger;
  appUrl: string;
  ip: string;
}

/** Лимиты (попыток / окно в секундах). Значения — docs/architecture/AUTH_FLOWS.md §8. */
export const LIMITS = {
  loginIp: [30, 900],
  loginEmail: [5, 900],
  registerIp: [5, 3600],
  resetIp: [10, 3600],
  resetEmail: [3, 3600],
  inviteUser: [30, 3600],
  mfaUser: [10, 900],
  acceptUser: [10, 3600],
} as const satisfies Record<string, readonly [number, number]>;

const INVITATION_TTL_HOURS = 72;

function input(form: FormData | Record<string, unknown>): Record<string, unknown> {
  return form instanceof FormData ? Object.fromEntries(form.entries()) : form;
}

/** Хранилище лимитов недоступно → отказываем (fail closed), а не пропускаем без ограничений. */
async function allowed(deps: Pick<Deps, 'limiter' | 'logger'>, checks: [Parameters<RateLimiter['hit']>[0], string, readonly [number, number]][]): Promise<boolean | 'unavailable'> {
  try {
    for (const [bucket, key, [limit, window]] of checks) {
      if (!(await deps.limiter.hit(bucket, key, limit, window))) return false;
    }
    return true;
  } catch (error) {
    deps.logger.error('rate limiter unavailable', { error });
    return 'unavailable';
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------

export async function login(form: FormData | Record<string, unknown>, locale: Locale, deps: Deps): Promise<Outcome> {
  const raw = input(form);
  const parsed = LoginSchema.safeParse(raw);
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });
  const { email, password } = parsed.data;

  const ok = await allowed(deps, [
    ['login_ip', deps.ip, LIMITS.loginIp],
    ['login_email', email, LIMITS.loginEmail],
  ]);
  if (ok === 'unavailable') return fail('unavailable');
  if (!ok) return fail('rate_limited');

  const result = await deps.gateway.signIn({ email, password });
  if (!result.ok) {
    if (result.reason === 'unavailable') return fail('unavailable');
    if (result.reason === 'email_not_confirmed') return fail('email_not_confirmed');
    if (result.reason === 'rate_limited') return fail('rate_limited');
    // Одна формулировка для «нет пользователя» и «неверный пароль».
    return fail('invalid_credentials');
  }
  return { kind: 'redirect', to: safeNext(raw.next, locale) };
}

/** Согласие при регистрации — на актуальные опубликованные документы школы; без них регистрация закрыта. */
export interface ConsentTarget {
  org: string;
  privacy: string;
  terms: string;
}

export async function register(form: FormData | Record<string, unknown>, locale: Locale, deps: Deps, consent: ConsentTarget | null): Promise<Outcome> {
  if (!consent) return fail('registration_closed');
  const parsed = RegisterSchema.safeParse({ ...input(form), locale });
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });
  const { email, password, fullName } = parsed.data;

  const ok = await allowed(deps, [['register_ip', deps.ip, LIMITS.registerIp]]);
  if (ok === 'unavailable') return fail('unavailable');
  if (!ok) return fail('rate_limited');

  const result = await deps.gateway.signUp({
    email,
    password,
    fullName,
    locale,
    consent,
    emailRedirectTo: `${deps.appUrl}/${locale}/auth/confirm`,
  });
  if (!result.ok) {
    if (result.reason === 'weak_password') return fail('weak_password', { fieldErrors: { password: ['password_too_short'] } });
    if (result.reason === 'unavailable') return fail('unavailable');
    if (result.reason === 'rate_limited') return fail('rate_limited');
    deps.logger.warn('sign-up failed', { reason: result.reason });
  }
  // Одинаковый ответ и для нового, и для уже зарегистрированного email (защита от перебора).
  return done('check_email');
}

export async function requestPasswordReset(form: FormData | Record<string, unknown>, locale: Locale, deps: Deps): Promise<Outcome> {
  const parsed = ForgotPasswordSchema.safeParse(input(form));
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });
  const { email } = parsed.data;

  const ok = await allowed(deps, [
    ['reset_ip', deps.ip, LIMITS.resetIp],
    ['reset_email', email, LIMITS.resetEmail],
  ]);
  if (ok === 'unavailable') return fail('unavailable');
  if (!ok) return fail('rate_limited');

  const result = await deps.gateway.sendPasswordReset(email, `${deps.appUrl}/${locale}/auth/confirm?next=/${locale}/reset-password`);
  if (!result.ok && result.reason === 'unavailable') return fail('unavailable');
  if (!result.ok) deps.logger.warn('password reset request failed', { reason: result.reason });
  return done('check_email');
}

export async function resetPassword(form: FormData | Record<string, unknown>, deps: Deps): Promise<Outcome> {
  const user = await deps.gateway.getUser();
  if (!user) return fail('session_expired');

  const parsed = ResetPasswordSchema.safeParse(input(form));
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });
  if (user.email && parsed.data.password.toLowerCase() === user.email) {
    return fail('validation', { fieldErrors: { password: ['password_same_as_email'] } });
  }

  const result = await deps.gateway.updatePassword(parsed.data.password);
  if (!result.ok) {
    if (result.reason === 'weak_password') return fail('weak_password', { fieldErrors: { password: ['password_too_short'] } });
    if (result.reason === 'same_password') return fail('same_password');
    if (result.reason === 'session_missing') return fail('session_expired');
    return fail('unavailable');
  }
  // Смена пароля завершает все остальные сессии (AUTH_FLOWS §4).
  const others = await deps.gateway.signOut('others');
  if (!others.ok) deps.logger.warn('could not revoke other sessions after password change', { reason: others.reason });
  return done('password_updated');
}

export async function verifyEmailLink(params: { tokenHash: string | null; type: string | null; next: string | null }, locale: Locale, deps: Pick<Deps, 'gateway' | 'logger'>): Promise<string> {
  const type = emailLinkTypes.find((t) => t === params.type);
  if (!params.tokenHash || !type || params.tokenHash.length > 512) return `/${locale}/login?error=link_invalid`;
  const result = await deps.gateway.verifyEmailLink(params.tokenHash, type);
  if (!result.ok) {
    deps.logger.warn('email link verification failed', { reason: result.reason, type });
    return `/${locale}/login?error=${result.reason === 'unavailable' ? 'unavailable' : 'link_invalid'}`;
  }
  if (type === 'recovery') return `/${locale}/reset-password`;
  return safeNext(params.next, locale);
}

export async function signOutOthers(deps: Deps): Promise<Outcome> {
  const user = await deps.gateway.getUser();
  if (!user) return fail('session_expired');
  const result = await deps.gateway.signOut('others');
  return result.ok ? done('signed_out_others') : fail('unavailable');
}

// --- MFA -------------------------------------------------------------------

export async function enrollMfa(deps: Deps): Promise<{ ok: true; factorId: string; qrCode: string; secret: string } | { ok: false; code: FormErrorCode }> {
  const user = await deps.gateway.getUser();
  if (!user) return { ok: false, code: 'session_expired' };
  const result = await deps.gateway.mfaEnrollTotp(`Okuspace ${new Date().toISOString().slice(0, 10)}`);
  return result.ok ? { ok: true, ...result.value } : { ok: false, code: 'unavailable' };
}

export async function verifyMfa(form: FormData | Record<string, unknown>, locale: Locale, deps: Deps): Promise<Outcome> {
  const user = await deps.gateway.getUser();
  if (!user) return fail('session_expired');
  const raw = input(form);
  const parsed = MfaCodeSchema.safeParse(raw);
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });

  const ok = await allowed(deps, [['mfa_user', user.id, LIMITS.mfaUser]]);
  if (ok === 'unavailable') return fail('unavailable');
  if (!ok) return fail('rate_limited');

  const factorId = typeof raw.factorId === 'string' ? raw.factorId : '';
  if (!/^[0-9a-f-]{36}$/i.test(factorId)) return fail('invalid_code');

  const result = await deps.gateway.mfaVerify(factorId, parsed.data.code);
  if (!result.ok) return fail(result.reason === 'unavailable' ? 'unavailable' : 'invalid_code');
  return { kind: 'redirect', to: safeNext(raw.next, locale) };
}

// --- Сотрудники ----------------------------------------------------------------

export interface MemberDeps extends Deps {
  repo: AccountRepository;
  user: SessionUser;
  now?: () => Date;
  token?: () => string;
}

export async function inviteMember(form: FormData | Record<string, unknown>, locale: Locale, deps: MemberDeps): Promise<Outcome> {
  if (deps.user.aal !== 'aal2') return fail('mfa_required');
  const parsed = InviteSchema.safeParse(input(form));
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });
  const { organizationId, branchId, email, role } = parsed.data;

  const memberships = await deps.repo.myMemberships(deps.user.id);
  if (!canAssignRole(memberships, role, organizationId, branchId)) return fail('forbidden');

  const ok = await allowed(deps, [['invite_user', deps.user.id, LIMITS.inviteUser]]);
  if (ok === 'unavailable') return fail('unavailable');
  if (!ok) return fail('rate_limited');

  const token = (deps.token ?? newInvitationToken)();
  const now = (deps.now ?? (() => new Date()))();
  const written = await deps.repo.createInvitation({
    organizationId,
    branchId,
    email,
    role,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_HOURS * 3600_000),
    createdBy: deps.user.id,
  });
  if (written === 'forbidden') return fail('forbidden');
  if (written !== 'ok') return fail(written === 'unavailable' ? 'unavailable' : 'validation');

  // Ссылка показывается пригласившему один раз; в БД хранится только хеш токена.
  return done('invited', { link: `${deps.appUrl}/${locale}/invite/${token}`, email });
}

export async function acceptInvitation(token: string, locale: Locale, deps: MemberDeps): Promise<Outcome> {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) return fail('invalid_invitation');
  const ok = await allowed(deps, [['accept_user', deps.user.id, LIMITS.acceptUser]]);
  if (ok === 'unavailable') return fail('unavailable');
  if (!ok) return fail('rate_limited');

  const result = await deps.repo.acceptInvitation(token);
  switch (result) {
    case 'ok':
      return { kind: 'redirect', to: `/${locale}/app` };
    case 'already_member':
      return fail('already_member');
    case 'unauthenticated':
      return fail('session_expired');
    case 'unavailable':
      return fail('unavailable');
    default:
      return fail('invalid_invitation');
  }
}

export async function setMembershipStatus(form: FormData | Record<string, unknown>, deps: MemberDeps): Promise<Outcome> {
  if (deps.user.aal !== 'aal2') return fail('mfa_required');
  const parsed = MembershipStatusSchema.safeParse(input(form));
  if (!parsed.success) return fail('validation', { fieldErrors: fieldErrors(parsed.error) });
  const { membershipId, status, reason } = parsed.data;

  const written = await deps.repo.setMembershipStatus(membershipId, status, status === 'active' ? null : reason);
  if (written === 'ok') return done('status_changed');
  if (written === 'unavailable') return fail('unavailable');
  // «Нет такой записи» и «нет прав» неразличимы для вызывающего.
  return fail('forbidden');
}
