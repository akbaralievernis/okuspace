import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerMatches, safeEqual } from '@/server/notifications/secret';

const rpc = vi.fn();
vi.mock('@/server/supabase/server', () => ({ createPrivilegedClient: () => ({ rpc }) }));

const SECRET = 'c'.repeat(40);

beforeEach(() => {
  rpc.mockReset();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('EMAIL_PROVIDER', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('secret helpers', () => {
  it('require a long secret and an exact match', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerMatches(SECRET, SECRET)).toBe(false);
    expect(bearerMatches(null, SECRET)).toBe(false);
    expect(bearerMatches('Bearer short', 'short')).toBe(false);
    expect(bearerMatches('Bearer ', undefined)).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});

async function cron(auth: string | null) {
  const { GET } = await import('@/app/api/cron/notifications/route');
  const headers = new Headers();
  if (auth) headers.set('authorization', auth);
  return GET(new NextRequest('http://localhost/api/cron/notifications', { headers }));
}

describe('cron route', () => {
  it('rejects calls without the secret and does nothing', async () => {
    expect((await cron(null)).status).toBe(401);
    expect((await cron('Bearer wrong')).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await cron('Bearer ')).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('runs every step independently: one failure does not cancel the others', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'generate_scheduled_notifications') return { data: null, error: { code: '57014' } };
      if (name === 'claim_deliveries') return { data: [], error: null };
      return { data: { deleted: 0 }, error: null };
    });
    const res = await cron(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scheduled).toEqual({ error: true });
    expect(body.deliveries).toEqual({ processed: 0, sent: 0, retry: 0, skipped: 0 });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['generate_scheduled_notifications', 'generate_task_reminders', 'generate_monthly_reports', 'claim_deliveries', 'monitoring_purge', 'crm_purge_stale']);
    expect(rpc).toHaveBeenCalledWith('crm_purge_stale', { p_months: 24 });
  });
});

async function hook(body: unknown, secret: string | null = SECRET) {
  const { POST } = await import('@/app/api/telegram/webhook/route');
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret) headers.set('x-telegram-bot-api-secret-token', secret);
  return POST(new NextRequest('http://localhost/api/telegram/webhook', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }));
}

describe('telegram webhook', () => {
  it('rejects a missing or wrong secret header', async () => {
    expect((await hook({}, null)).status).toBe(401);
    expect((await hook({}, 'x'.repeat(40))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('links a chat by a one-time code and ignores everything else', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect((await hook({ message: { chat: { id: 777 }, text: '/start 0A1B2C3D4E' } })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('link_telegram', { p_code: '0A1B2C3D4E', p_chat_id: '777' });
    rpc.mockClear();
    for (const body of [{ message: { chat: { id: 1 }, text: 'hello' } }, { message: { chat: { id: 1 }, text: '/start ../../' } }, { edited_message: {} }, 'not json']) {
      expect((await hook(body)).status).toBe(200);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a database failure still answers 200 so Telegram does not retry forever', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '08006' } });
    expect((await hook({ message: { chat: { id: 5 }, text: '/start ABCDEF0123' } })).status).toBe(200);
  });
});
