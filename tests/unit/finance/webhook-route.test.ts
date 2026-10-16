import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from '@/server/finance/webhook';

/** Обработчик webhook целиком, БД подменена: порядок проверок и ответы провайдеру. */
const rpc = vi.fn();
vi.mock('@/server/supabase/server', () => ({ createPrivilegedClient: () => ({ rpc }) }));

const SECRET = 'test-webhook-secret-not-real-000000000000';
const INVOICE = '8a100000-0000-4000-8000-000000000001';
const event = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'payment.succeeded', eventId: 'evt_1', operationId: 'op_1', invoiceId: INVOICE, amount: '1500.00', currency: 'KGS', ...o });

async function post(provider: string, body: string, signature?: string | null) {
  const { POST } = await import('@/app/api/payments/webhook/[provider]/route');
  const headers = new Headers({ 'content-type': 'application/json' });
  const sig = signature === undefined ? sign(body, SECRET, Math.floor(Date.now() / 1000)) : signature;
  if (sig) headers.set('x-okuspace-signature', sig);
  const res = await POST(new NextRequest(`http://localhost/api/payments/webhook/${provider}`, { method: 'POST', body, headers }), { params: Promise.resolve({ provider }) });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
}

beforeEach(() => {
  vi.stubEnv('PAYMENT_PROVIDER', 'test_psp');
  vi.stubEnv('PAYMENT_WEBHOOK_SECRET', SECRET);
  rpc.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('payment webhook endpoint', () => {
  it('records a correctly signed event, passing the amount as an exact string', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'recorded', paymentId: 'p1' }, error: null });
    expect(await post('test_psp', event())).toEqual({ status: 200, json: { outcome: 'recorded' } });
    expect(rpc).toHaveBeenCalledWith('record_provider_payment', expect.objectContaining({ p_provider: 'test_psp', p_event_id: 'evt_1', p_amount: '1500.00', p_invoice: INVOICE, p_provider_ref: 'op_1' }));
  });

  it('a repeated event is answered 200 "duplicate" (the database keeps one payment)', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'duplicate', paymentId: 'p1' }, error: null });
    expect(await post('test_psp', event())).toEqual({ status: 200, json: { outcome: 'duplicate' } });
  });

  it('unknown provider → 404; not configured → 404; nothing reaches the database', async () => {
    expect((await post('other_psp', event())).status).toBe(404);
    vi.stubEnv('PAYMENT_WEBHOOK_SECRET', '');
    expect((await post('test_psp', event())).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('bad or missing signature → 401; invalid payload → 400; too large → 413', async () => {
    expect((await post('test_psp', event(), null)).status).toBe(401);
    expect((await post('test_psp', event(), sign(event(), 'wrong-secret-000000000000000000000000', Math.floor(Date.now() / 1000)))).status).toBe(401);
    expect((await post('test_psp', event({ amount: 1500 }))).status).toBe(400);
    expect((await post('test_psp', 'x'.repeat(70 * 1024))).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a temporary database error → 503, so the provider retries (safe because recording is idempotent)', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
    expect((await post('test_psp', event())).status).toBe(503);
  });
});
