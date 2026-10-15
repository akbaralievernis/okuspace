import { describe, expect, it } from 'vitest';
import * as uc from '@/server/auth/use-cases';
import { hashToken } from '@/server/auth/use-cases';
import { CONSENT_VERSION } from '@/lib/legal';
import { BRANCH_A1, BRANCH_A2, ORG, USER, adminA1, brokenLimiter, deps, fakeGateway, fakeRepo, memberDeps, memoryLimiter } from './fakes';

const valid = { email: 'User@Example.test ', password: 'correct horse battery' };
const errorCode = (o: uc.Outcome) => (o.kind === 'state' && o.state.status === 'error' ? o.state.code : null);
const successCode = (o: uc.Outcome) => (o.kind === 'state' && o.state.status === 'success' ? o.state.code : null);

describe('login', () => {
  it('rejects invalid input without calling Auth', async () => {
    const d = deps();
    const out = await uc.login({ email: 'not-an-email', password: '' }, 'ru', d);
    expect(errorCode(out)).toBe('validation');
    expect(d.gateway.signIn).not.toHaveBeenCalled();
  });

  it('normalises email and redirects to a safe next path', async () => {
    const d = deps();
    const out = await uc.login({ ...valid, next: '/ru/app/members?x=1' }, 'ru', d);
    expect(d.gateway.signIn).toHaveBeenCalledWith({ email: 'user@example.test', password: valid.password });
    expect(out).toEqual({ kind: 'redirect', to: '/ru/app/members?x=1' });
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/de/app', 'javascript:alert(1)'])(
    'never redirects off-site (next=%s)',
    async (next) => {
      expect(await uc.login({ ...valid, next }, 'ky', deps())).toEqual({ kind: 'redirect', to: '/ky/app' });
    },
  );

  it('uses the same message for unknown user and wrong password', async () => {
    const d = deps({ gateway: fakeGateway({ signIn: async () => ({ ok: false, reason: 'invalid_credentials' }) }) });
    expect(errorCode(await uc.login(valid, 'ru', d))).toBe('invalid_credentials');
    const d2 = deps({ gateway: fakeGateway({ signIn: async () => ({ ok: false, reason: 'unknown' }) }) });
    expect(errorCode(await uc.login(valid, 'ru', d2))).toBe('invalid_credentials');
  });

  it('locks out an email after 5 attempts in the window, regardless of IP', async () => {
    const limiter = memoryLimiter();
    for (let i = 0; i < 5; i++) await uc.login(valid, 'ru', deps({ limiter, ip: `198.51.100.${i}` }));
    const d = deps({ limiter, ip: '198.51.100.99' });
    expect(errorCode(await uc.login(valid, 'ru', d))).toBe('rate_limited');
    expect(d.gateway.signIn).not.toHaveBeenCalled();
  });

  it('fails closed when the rate limiter is unavailable', async () => {
    const d = deps({ limiter: brokenLimiter() });
    expect(errorCode(await uc.login(valid, 'ru', d))).toBe('unavailable');
    expect(d.gateway.signIn).not.toHaveBeenCalled();
  });

  it('reports Auth outages as unavailable, not as wrong credentials', async () => {
    const d = deps({ gateway: fakeGateway({ signIn: async () => ({ ok: false, reason: 'unavailable' }) }) });
    expect(errorCode(await uc.login(valid, 'ru', d))).toBe('unavailable');
  });
});

describe('register', () => {
  const form = { fullName: 'Айгуль Асанова', email: 'new@example.test', password: 'long enough secret', consent: 'on' };

  it('requires consent, a name and a strong enough password', async () => {
    const out = await uc.register({ fullName: '', email: 'x', password: 'short' }, 'ru', deps());
    expect(out.kind === 'state' && out.state.status === 'error' && out.state.fieldErrors).toEqual({
      fullName: ['name_required'],
      email: ['email_invalid'],
      password: ['password_too_short'],
      consent: ['consent_required'],
    });
  });

  it('rejects a password equal to the email', async () => {
    const out = await uc.register({ ...form, password: 'new@example.test' }, 'ru', deps());
    expect(out.kind === 'state' && out.state.status === 'error' && out.state.fieldErrors?.password).toEqual(['password_same_as_email']);
  });

  it('passes locale, consent version and the confirmation URL to Auth; grants no role', async () => {
    const d = deps();
    expect(successCode(await uc.register(form, 'ky', d))).toBe('check_email');
    expect(d.gateway.signUp).toHaveBeenCalledWith({
      email: 'new@example.test',
      password: form.password,
      fullName: form.fullName,
      locale: 'ky',
      consentVersion: CONSENT_VERSION,
      emailRedirectTo: 'https://okuspace.example.test/ky/auth/confirm',
    });
  });

  it('answers identically when the email is already registered (no enumeration)', async () => {
    const d = deps({ gateway: fakeGateway({ signUp: async () => ({ ok: false, reason: 'unknown' }) }) });
    expect(await uc.register(form, 'ru', d)).toEqual(await uc.register(form, 'ru', deps()));
  });

  it('limits registrations per IP', async () => {
    const limiter = memoryLimiter();
    for (let i = 0; i < 5; i++) await uc.register({ ...form, email: `u${i}@example.test` }, 'ru', deps({ limiter }));
    expect(errorCode(await uc.register(form, 'ru', deps({ limiter })))).toBe('rate_limited');
  });
});

describe('password recovery', () => {
  it('always answers "check your email", whether or not the account exists', async () => {
    const missing = deps({ gateway: fakeGateway({ sendPasswordReset: async () => ({ ok: false, reason: 'unknown' }) }) });
    expect(successCode(await uc.requestPasswordReset({ email: 'nobody@example.test' }, 'ru', missing))).toBe('check_email');
    expect(successCode(await uc.requestPasswordReset({ email: 'user@example.test' }, 'ru', deps()))).toBe('check_email');
  });

  it('sends a recovery link that lands on the reset page through /auth/confirm', async () => {
    const d = deps();
    await uc.requestPasswordReset({ email: 'user@example.test' }, 'en', d);
    expect(d.gateway.sendPasswordReset).toHaveBeenCalledWith('user@example.test', 'https://okuspace.example.test/en/auth/confirm?next=/en/reset-password');
  });

  it('limits recovery e-mails per address', async () => {
    const limiter = memoryLimiter();
    for (let i = 0; i < 3; i++) await uc.requestPasswordReset({ email: 'user@example.test' }, 'ru', deps({ limiter, ip: `10.0.0.${i}` }));
    expect(errorCode(await uc.requestPasswordReset({ email: 'user@example.test' }, 'ru', deps({ limiter })))).toBe('rate_limited');
  });

  it('setting a new password requires the recovery session and revokes other sessions', async () => {
    const noSession = deps({ gateway: fakeGateway({ getUser: async () => null }) });
    expect(errorCode(await uc.resetPassword({ password: 'brand new secret', confirm: 'brand new secret' }, noSession))).toBe('session_expired');

    const d = deps();
    expect(successCode(await uc.resetPassword({ password: 'brand new secret', confirm: 'brand new secret' }, d))).toBe('password_updated');
    expect(d.gateway.updatePassword).toHaveBeenCalledWith('brand new secret');
    expect(d.gateway.signOut).toHaveBeenCalledWith('others');
  });

  it('validates confirmation and forbids the email as password', async () => {
    const mismatch = await uc.resetPassword({ password: 'brand new secret', confirm: 'other' }, deps());
    expect(mismatch.kind === 'state' && mismatch.state.status === 'error' && mismatch.state.fieldErrors?.confirm).toEqual(['passwords_mismatch']);
    const same = await uc.resetPassword({ password: 'ADMIN@example.test', confirm: 'ADMIN@example.test' }, deps());
    expect(same.kind === 'state' && same.state.status === 'error' && same.state.fieldErrors?.password).toEqual(['password_same_as_email']);
  });
});

describe('email links (/auth/confirm)', () => {
  it('rejects unknown types and missing hashes', async () => {
    const d = deps();
    expect(await uc.verifyEmailLink({ tokenHash: 'h', type: 'magic', next: null }, 'ru', d)).toBe('/ru/login?error=link_invalid');
    expect(await uc.verifyEmailLink({ tokenHash: null, type: 'signup', next: null }, 'ru', d)).toBe('/ru/login?error=link_invalid');
    expect(d.gateway.verifyEmailLink).not.toHaveBeenCalled();
  });

  it('sends recovery links to the reset page and others to a safe next', async () => {
    expect(await uc.verifyEmailLink({ tokenHash: 'h', type: 'recovery', next: '//evil' }, 'ru', deps())).toBe('/ru/reset-password');
    expect(await uc.verifyEmailLink({ tokenHash: 'h', type: 'signup', next: 'https://evil' }, 'ru', deps())).toBe('/ru/app');
  });

  it('reports expired links', async () => {
    const d = deps({ gateway: fakeGateway({ verifyEmailLink: async () => ({ ok: false, reason: 'link_invalid' }) }) });
    expect(await uc.verifyEmailLink({ tokenHash: 'h', type: 'signup', next: null }, 'ru', d)).toBe('/ru/login?error=link_invalid');
  });
});

describe('MFA verification', () => {
  const factorId = '11111111-2222-4333-8444-555555555555';

  it('validates the code and factor id', async () => {
    expect(errorCode(await uc.verifyMfa({ code: '12a456', factorId }, 'ru', deps()))).toBe('validation');
    expect(errorCode(await uc.verifyMfa({ code: '123456', factorId: 'x' }, 'ru', deps()))).toBe('invalid_code');
  });

  it('limits attempts per user', async () => {
    const limiter = memoryLimiter();
    const failing = fakeGateway({ mfaVerify: async () => ({ ok: false, reason: 'invalid_code' }) });
    for (let i = 0; i < 10; i++) await uc.verifyMfa({ code: '000000', factorId }, 'ru', deps({ limiter, gateway: failing }));
    expect(errorCode(await uc.verifyMfa({ code: '123456', factorId }, 'ru', deps({ limiter })))).toBe('rate_limited');
  });

  it('redirects after a valid code', async () => {
    expect(await uc.verifyMfa({ code: '123456', factorId, next: '/ru/app/members' }, 'ru', deps())).toEqual({ kind: 'redirect', to: '/ru/app/members' });
  });
});

describe('staff invitations', () => {
  const form = { organizationId: ORG, branchId: BRANCH_A1, email: 'Teacher@Example.test', role: 'teacher' };

  it('requires MFA', async () => {
    const d = memberDeps([adminA1], { user: { ...USER, aal: 'aal1' } });
    expect(errorCode(await uc.inviteMember(form, 'ru', d))).toBe('mfa_required');
    expect(d.repo.createInvitation).not.toHaveBeenCalled();
  });

  it('refuses roles and branches outside the inviter’s grants before touching the database', async () => {
    for (const bad of [{ role: 'branch_manager' }, { branchId: BRANCH_A2 }, { role: 'accountant' }]) {
      const d = memberDeps([adminA1]);
      expect(errorCode(await uc.inviteMember({ ...form, ...bad }, 'ru', d))).toBe('forbidden');
      expect(d.repo.createInvitation).not.toHaveBeenCalled();
    }
    expect(errorCode(await uc.inviteMember({ ...form, role: 'org_director', branchId: '' }, 'ru', memberDeps([adminA1])))).toBe('validation');
  });

  it('stores only the token hash, expires in 72 hours and shows the link once', async () => {
    const now = new Date('2026-10-15T10:00:00Z');
    const d = memberDeps([adminA1], { now: () => now, token: () => 'T'.repeat(43) });
    const out = await uc.inviteMember(form, 'ky', d);
    expect(out).toEqual({
      kind: 'state',
      state: { status: 'success', code: 'invited', data: { link: `https://okuspace.example.test/ky/invite/${'T'.repeat(43)}`, email: 'teacher@example.test' } },
    });
    expect(d.repo.createInvitation).toHaveBeenCalledWith({
      organizationId: ORG,
      branchId: BRANCH_A1,
      email: 'teacher@example.test',
      role: 'teacher',
      tokenHash: hashToken('T'.repeat(43)),
      expiresAt: new Date('2026-10-18T10:00:00Z'),
      createdBy: USER.id,
    });
    expect(JSON.stringify((d.repo.createInvitation as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain('TTTT');
  });

  it('generates high-entropy URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => uc.newInvitationToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('maps a database refusal to forbidden', async () => {
    const d = memberDeps([adminA1], { repo: fakeRepo([adminA1], { createInvitation: async () => 'forbidden' }) });
    expect(errorCode(await uc.inviteMember(form, 'ru', d))).toBe('forbidden');
  });
});

describe('accepting an invitation', () => {
  it('rejects malformed tokens without a database call', async () => {
    const d = memberDeps([]);
    expect(errorCode(await uc.acceptInvitation('../../etc', 'ru', d))).toBe('invalid_invitation');
    expect(d.repo.acceptInvitation).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 'invalid_invitation'],
    ['already_member', 'already_member'],
    ['unauthenticated', 'session_expired'],
    ['unavailable', 'unavailable'],
  ] as const)('maps %s to %s', async (repoResult, code) => {
    const d = memberDeps([], { repo: fakeRepo([], { acceptInvitation: async () => repoResult }) });
    expect(errorCode(await uc.acceptInvitation('A'.repeat(43), 'ru', d))).toBe(code);
  });

  it('redirects to the workspace on success', async () => {
    expect(await uc.acceptInvitation('A'.repeat(43), 'en', memberDeps([]))).toEqual({ kind: 'redirect', to: '/en/app' });
  });
});

describe('blocking and restoring access', () => {
  const id = 'c0000000-0000-4000-8000-000000000009';

  it('requires MFA and a reason for blocking', async () => {
    expect(errorCode(await uc.setMembershipStatus({ membershipId: id, status: 'blocked', reason: 'x' }, memberDeps([adminA1], { user: { ...USER, aal: 'aal1' } })))).toBe('mfa_required');
    const out = await uc.setMembershipStatus({ membershipId: id, status: 'blocked', reason: '' }, memberDeps([adminA1]));
    expect(out.kind === 'state' && out.state.status === 'error' && out.state.fieldErrors?.reason).toEqual(['reason_required']);
  });

  it('restores without a reason and clears it', async () => {
    const d = memberDeps([adminA1]);
    expect(successCode(await uc.setMembershipStatus({ membershipId: id, status: 'active' }, d))).toBe('status_changed');
    expect(d.repo.setMembershipStatus).toHaveBeenCalledWith(id, 'active', null);
  });

  it('does not distinguish "not found" from "not allowed"', async () => {
    const d = memberDeps([adminA1], { repo: fakeRepo([adminA1], { setMembershipStatus: async () => 'forbidden' }) });
    expect(errorCode(await uc.setMembershipStatus({ membershipId: id, status: 'revoked', reason: 'left the school' }, d))).toBe('forbidden');
  });
});
