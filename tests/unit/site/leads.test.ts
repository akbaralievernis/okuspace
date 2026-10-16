import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import { leadDedupeKey, submitLead, type LeadDeps, type LeadStore } from '@/server/public/leads';
import { brokenLimiter, memoryLimiter } from '../auth/fakes';

const SLOT = '11111111-2222-4333-8444-555555555555';
const base = { kind: 'trial', fullName: 'Асель Токтогулова', phone: '+996 555 123 456', slotId: SLOT, consent: 'on', consentVersion: '2026-10-15' };

function deps(over: Partial<LeadDeps> = {}): LeadDeps & { store: LeadStore & { submit: ReturnType<typeof vi.fn> } } {
  return {
    store: { submit: vi.fn(async () => 'ok' as const) },
    limiter: memoryLimiter(),
    logger: createLogger({ level: 'error', sink: () => {} }),
    orgSlug: 'school-a',
    privacyVersion: '2026-10-15',
    ip: '203.0.113.9',
    today: () => '2026-10-16',
    ...over,
  } as LeadDeps & { store: LeadStore & { submit: ReturnType<typeof vi.fn> } };
}

describe('submitLead', () => {
  it('stores a valid trial request against the current privacy version', async () => {
    const d = deps();
    expect(await submitLead(base, 'ky', d)).toEqual({ status: 'success', code: 'request_received' });
    expect(d.store.submit).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: 'school-a', kind: 'trial', slotId: SLOT, phone: '+996 555 123 456', email: null, locale: 'ky', consentVersion: '2026-10-15' }),
    );
  });

  it('requires a phone or email, consent and (for trials) a slot', async () => {
    const out = await submitLead({ kind: 'trial', fullName: 'A' }, 'ru', deps());
    expect(out.status === 'error' && out.fieldErrors).toEqual({
      fullName: ['name_required'],
      consent: ['consent_required'],
      phone: ['contact_required'],
      slotId: ['slot_required'],
    });
  });

  it('validates phone format and message length', async () => {
    const out = await submitLead({ ...base, phone: 'call me', message: 'x'.repeat(2001) }, 'ru', deps());
    expect(out.status === 'error' && out.fieldErrors).toMatchObject({ phone: ['phone_invalid'], message: ['message_too_long'] });
  });

  it('ignores a slot on a contact request', async () => {
    const d = deps();
    await submitLead({ ...base, kind: 'contact' }, 'ru', d);
    expect(d.store.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contact', slotId: null }));
  });

  it('answers bots that filled the honeypot like humans, but stores nothing', async () => {
    const d = deps();
    expect(await submitLead({ ...base, website: 'http://spam.example' }, 'ru', d)).toEqual({ status: 'success', code: 'request_received' });
    expect(d.store.submit).not.toHaveBeenCalled();
  });

  it('refuses when no privacy policy is published or the form is outdated', async () => {
    expect(await submitLead(base, 'ru', deps({ privacyVersion: null }))).toEqual({ status: 'error', code: 'stale_form' });
    expect(await submitLead({ ...base, consentVersion: '2026-01-01' }, 'ru', deps())).toEqual({ status: 'error', code: 'stale_form' });
  });

  it('limits requests per IP and per contact; fails closed without the limiter', async () => {
    const limiter = memoryLimiter();
    for (let i = 0; i < 3; i++) await submitLead(base, 'ru', deps({ limiter, ip: `10.0.0.${i}` }));
    expect(await submitLead(base, 'ru', deps({ limiter, ip: '10.0.0.99' }))).toEqual({ status: 'error', code: 'rate_limited' });
    expect(await submitLead(base, 'ru', deps({ limiter: brokenLimiter() }))).toEqual({ status: 'error', code: 'unavailable' });
  });

  it.each([
    ['slot_full', 'slot_full'],
    ['slot_unavailable', 'slot_unavailable'],
    ['stale_consent', 'stale_form'],
    ['unavailable', 'unavailable'],
    ['invalid', 'validation'],
  ] as const)('maps store result %s to %s', async (result, code) => {
    const d = deps({ store: { submit: vi.fn(async () => result) } });
    expect(await submitLead(base, 'ru', d)).toEqual({ status: 'error', code });
  });

  it('uses the same dedupe key for a resubmission on the same day, regardless of phone formatting', async () => {
    const d = deps();
    await submitLead(base, 'ru', d);
    await submitLead({ ...base, phone: '+996555123456' }, 'ru', d);
    const [a, b] = d.store.submit.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(leadDedupeKey({ orgSlug: 'school-a', kind: 'trial', slotId: SLOT, contact: '+996555123456', day: '2026-10-17' })).not.toBe(a);
  });
});
