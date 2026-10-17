import { describe, expect, it, vi } from 'vitest';
import { botPayload, createForwarder, normalizeKgPhone, ruYears, SignupSchema, submitSignup, type SignupDeps } from '@/server/public/signup';

const COURSE = '11111111-1111-4111-8111-111111111111';
const B1 = '22222222-2222-4222-8222-222222222222';
const B2 = '33333333-3333-4333-8333-333333333333';
const base = {
  forChild: 'child',
  clientName: 'Гульмира',
  childName: 'Айбек',
  childAge: '8',
  phone: '+996 555 123 456',
  courseId: COURSE,
  branchIds: [B1, B2],
  heardFrom: 'instagram',
  consent: 'on',
  consentVersion: '2026-10-17',
};

function deps(over: Partial<SignupDeps> = {}) {
  const submit = vi.fn<SignupDeps['store']['submit']>(async () => ({ result: 'ok', courseCode: 'Kids English', branchNumbers: [1, 5], duplicate: false }));
  const forward = vi.fn(async () => undefined);
  const d: SignupDeps = {
    store: { submit },
    limiter: { hit: vi.fn(async () => true) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SignupDeps['logger'],
    orgSlug: 'demo',
    privacyVersion: '2026-10-17',
    ip: '127.0.0.1',
    forward,
    today: () => '2026-10-17',
    ...over,
  };
  return { d, submit, forward };
}

describe('phone and age helpers', () => {
  it('accepts Kyrgyz numbers in common formats', () => {
    expect(normalizeKgPhone('+996 555 123 456')).toBe('+996555123456');
    expect(normalizeKgPhone('996555123456')).toBe('+996555123456');
    expect(normalizeKgPhone('0555 12-34-56')).toBe('+996555123456');
    expect(normalizeKgPhone('+7 999 123 45 67')).toBeNull();
    expect(normalizeKgPhone('12345')).toBeNull();
  });
  it('declines years in Russian', () => {
    expect([1, 2, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(ruYears)).toEqual(['1 год', '2 года', '5 лет', '11 лет', '12 лет', '14 лет', '21 год', '22 года', '25 лет', '101 год', '111 лет']);
  });
});

describe('signup form validation', () => {
  const errors = (over: Record<string, unknown>) => {
    const r = SignupSchema.safeParse({ ...base, ...over });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`);
  };
  it('requires child data only for a child', () => {
    expect(errors({})).toEqual([]);
    expect(errors({ childName: '', childAge: '' })).toEqual(expect.arrayContaining(['childName:child_required', 'childAge:age_invalid']));
    expect(errors({ forChild: 'self', childName: '', childAge: '' })).toEqual([]);
    expect(errors({ childAge: '150' })).toEqual(['childAge:age_invalid']);
  });
  it('requires a course, at least one branch, a source and consent', () => {
    expect(errors({ courseId: '' })).toEqual(['courseId:course_required']);
    expect(errors({ branchIds: [] })).toEqual(['branchIds:branches_required']);
    expect(errors({ heardFrom: '' })).toEqual(['heardFrom:heard_required']);
    expect(errors({ consent: undefined })).toEqual(['consent:consent_required']);
    expect(errors({ phone: '+7 999' })).toEqual(['phone:phone_invalid']);
  });
});

describe('payload for the school Telegram bot', () => {
  it('matches the bot format exactly (unknown fields would be dropped by the bot)', () => {
    const v = SignupSchema.parse(base);
    expect(botPayload(v, 'Kids English', [1, 5])).toEqual({
      clientName: 'Гульмира',
      childName: 'Айбек (8 лет)',
      phone: '+996555123456',
      course: 'Kids English',
      source: 'Instagram',
      branchIds: [1, 5],
    });
    const self = SignupSchema.parse({ ...base, forChild: 'self', childName: '', childAge: '', heardFrom: 'relatives' });
    expect(botPayload(self, 'IELTS', [2])).toMatchObject({ childName: '— (взрослый)', source: 'Родственники / знакомые' });
    expect(Object.keys(botPayload(v, 'x', []))).toEqual(['clientName', 'childName', 'phone', 'course', 'source', 'branchIds']);
  });
});

describe('submitSignup', () => {
  it('stores, then forwards to the bot', async () => {
    const { d, submit, forward } = deps();
    expect(await submitSignup(base, 'ru', d)).toEqual({ status: 'success', code: 'request_received' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ phone: '+996555123456', branchIds: [B1, B2], orgSlug: 'demo', consentVersion: '2026-10-17' }));
    expect(submit.mock.calls[0]![0].dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ course: 'Kids English', branchIds: [1, 5] }));
  });

  it('a forwarding failure or a repeated request does not bother the person', async () => {
    const failing = deps({ forward: vi.fn(async () => Promise.reject(new Error('bot down'))) });
    expect((await submitSignup(base, 'ru', failing.d)).status).toBe('success');
    expect(failing.d.logger.error).toHaveBeenCalledWith('signup forward failed', { error: 'bot down' });
    const dup = deps();
    dup.submit.mockResolvedValueOnce({ result: 'ok', courseCode: 'x', branchNumbers: [], duplicate: true });
    expect((await submitSignup(base, 'ru', dup.d)).status).toBe('success');
    expect(dup.forward).not.toHaveBeenCalled();
  });

  it('honeypot, stale form, closed intake and rate limits stop before storing', async () => {
    for (const [raw, over, code] of [
      [{ ...base, website: 'spam' }, {}, 'request_received'],
      [{ ...base, consentVersion: '2020-01-01' }, {}, 'stale_form'],
      [base, { privacyVersion: null }, 'stale_form'],
      [base, { limiter: { hit: vi.fn(async () => false) } }, 'rate_limited'],
    ] as const) {
      const { d, submit, forward } = deps(over as Partial<SignupDeps>);
      const state = await submitSignup(raw as Record<string, unknown>, 'ru', d);
      expect(state.status !== 'idle' ? state.code : null).toBe(code);
      expect(submit).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    }
  });
});

describe('createForwarder', () => {
  it('is off without an https address; posts JSON with an optional token', async () => {
    expect(createForwarder(undefined, undefined)).toBeUndefined();
    expect(createForwarder('http://bot.example/api/requests', undefined)).toBeUndefined();
    const f = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const send = createForwarder('https://bot.example/api/requests', 'tok', f)!;
    await send({ clientName: 'a', childName: 'b', phone: '+996555123456', course: 'IELTS', source: 'Instagram', branchIds: [1] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://bot.example/api/requests');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init!.body as string)).toEqual({ clientName: 'a', childName: 'b', phone: '+996555123456', course: 'IELTS', source: 'Instagram', branchIds: [1] });
    const bad = createForwarder('https://bot.example/x', undefined, vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 })))!;
    await expect(bad({ clientName: 'a', childName: 'b', phone: 'c', course: 'd', source: 'e', branchIds: [] })).rejects.toThrow('forward http 500');
  });
});
