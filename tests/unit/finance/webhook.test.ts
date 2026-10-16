import { describe, expect, it } from 'vitest';
import { PaymentEventSchema, TOLERANCE_SECONDS, sign, verifySignature } from '@/server/finance/webhook';

const SECRET = 'test-webhook-secret-not-real-000000000000';
const BODY = JSON.stringify({ type: 'payment.succeeded', eventId: 'evt_1', operationId: 'op_1', invoiceId: '8a100000-0000-4000-8000-000000000001', amount: '1500.00', currency: 'KGS' });
const NOW = 1_800_000_000;

describe('webhook signature', () => {
  it('accepts a correct signature of the raw body', () => {
    expect(verifySignature(BODY, sign(BODY, SECRET, NOW), SECRET, NOW)).toEqual({ ok: true });
  });

  it('rejects a tampered body, a wrong secret and a missing or malformed header', () => {
    const header = sign(BODY, SECRET, NOW);
    expect(verifySignature(BODY.replace('1500.00', '9500.00'), header, SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature(BODY, sign(BODY, 'another-secret-0000000000000000000000', NOW), SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature(BODY, null, SECRET, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(verifySignature(BODY, 't=abc,v1=zz', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySignature(BODY, `t=${NOW},v1=${'0'.repeat(63)}`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects replays of old requests (timestamp outside the tolerance), both directions', () => {
    const old = sign(BODY, SECRET, NOW - TOLERANCE_SECONDS - 1);
    const future = sign(BODY, SECRET, NOW + TOLERANCE_SECONDS + 1);
    expect(verifySignature(BODY, old, SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifySignature(BODY, future, SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifySignature(BODY, sign(BODY, SECRET, NOW - TOLERANCE_SECONDS), SECRET, NOW)).toEqual({ ok: true });
  });
});

describe('payment event payload', () => {
  it('requires the amount as an exact decimal string, never a float', () => {
    const base = JSON.parse(BODY) as Record<string, unknown>;
    expect(PaymentEventSchema.safeParse(base).success).toBe(true);
    expect(PaymentEventSchema.safeParse({ ...base, amount: 1500 }).success).toBe(false);
    expect(PaymentEventSchema.safeParse({ ...base, amount: '1500.005' }).success).toBe(false);
    expect(PaymentEventSchema.safeParse({ ...base, amount: '-1' }).success).toBe(false);
    expect(PaymentEventSchema.safeParse({ ...base, currency: 'som' }).success).toBe(false);
    expect(PaymentEventSchema.safeParse({ ...base, type: 'payment.failed' }).success).toBe(false);
  });
});
