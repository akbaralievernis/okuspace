import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingSchema, newDeviceToken, parseDeviceAuth, tokenHash } from '@/server/monitoring/device';

const rpc = vi.fn();
vi.mock('@/server/supabase/server', () => ({ createPrivilegedClient: () => ({ rpc }) }));

const DEVICE = 'c0000000-0000-4000-8000-000000000001';
const { token } = newDeviceToken();
const auth = `Bearer ${DEVICE}.${token}`;
const now = new Date().toISOString();

async function post(body: unknown, authorization: string | null = auth) {
  const { POST } = await import('@/app/api/monitoring/ingest/route');
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization) headers.set('authorization', authorization);
  const res = await POST(new NextRequest('http://localhost/api/monitoring/ingest', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }));
  return res.status;
}

beforeEach(() => rpc.mockReset());

describe('device protocol', () => {
  it('accepts numbers only; images or any extra field are rejected', () => {
    expect(ReadingSchema.safeParse({ kind: 'occupancy', count: 12, observedAt: now }).success).toBe(true);
    expect(ReadingSchema.safeParse({ kind: 'in', observedAt: now }).success).toBe(true);
    expect(ReadingSchema.safeParse({ kind: 'occupancy', count: 12, observedAt: now, image: 'data:image/jpeg;base64,AAAA' }).success).toBe(false);
    expect(ReadingSchema.safeParse({ kind: 'occupancy', count: 12, observedAt: now, faces: [] }).success).toBe(false);
    expect(ReadingSchema.safeParse({ kind: 'in', count: 3, observedAt: now }).success).toBe(false);
    expect(ReadingSchema.safeParse({ kind: 'occupancy', observedAt: now }).success).toBe(false);
    expect(ReadingSchema.safeParse({ kind: 'occupancy', count: 1.5, observedAt: now }).success).toBe(false);
  });

  it('device tokens are random, hashed for storage, and parsed from the bearer header', () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(tokenHash(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseDeviceAuth(`Bearer ${DEVICE}.${a.token}`)).toEqual({ deviceId: DEVICE, token: a.token });
    expect(parseDeviceAuth(`Bearer ${DEVICE}`)).toBeNull();
    expect(parseDeviceAuth(`Basic ${DEVICE}.${a.token}`)).toBeNull();
    expect(parseDeviceAuth(null)).toBeNull();
  });
});

describe('ingest endpoint', () => {
  it('passes only the token hash to the database and maps outcomes to HTTP codes', async () => {
    for (const [outcome, status] of [
      ['recorded', 200],
      ['duplicate', 200],
      ['unauthorized', 401],
      ['disabled', 403],
      ['unassigned', 409],
      ['rejected', 400],
    ] as const) {
      rpc.mockResolvedValueOnce({ data: { outcome }, error: null });
      expect(await post({ kind: 'occupancy', count: 7, observedAt: now }), outcome).toBe(status);
    }
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).toMatchObject({ p_device: DEVICE, p_token_sha256: tokenHash(token), p_kind: 'occupancy', p_people_count: 7 });
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it('rejects missing credentials, invalid readings and oversized bodies before the database', async () => {
    expect(await post({ kind: 'occupancy', count: 7, observedAt: now }, null)).toBe(401);
    expect(await post({ kind: 'occupancy', count: 7, observedAt: now, image: 'x' })).toBe(400);
    expect(await post('not json')).toBe(400);
    expect(await post({ kind: 'occupancy', count: 7, observedAt: now, pad: 'x'.repeat(3000) })).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a database error → 503 (device retries; repeats are ignored by the database)', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '08006' } });
    expect(await post({ kind: 'in', observedAt: now })).toBe(503);
  });
});
