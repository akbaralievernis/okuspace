import { describe, expect, it, vi } from 'vitest';
import { ResendEmail, TelegramBot, classify, configuredChannels } from '@/server/notifications/channels';

const KEY = 'fake-email-key-for-unit-tests';
const TOKEN = '1:fake_bot_token_for_unit_tests';
const msg = { subject: 'S', text: 'T', idempotencyKey: 'd-1' };
const respond = (status: number, body: unknown = {}) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('classify', () => {
  it('2xx sent, 408/429/5xx retry, other 4xx permanent', () => {
    expect(classify(200)).toBe('sent');
    expect(classify(202)).toBe('sent');
    for (const s of [408, 429, 500, 503]) expect(classify(s)).toBe('error');
    for (const s of [400, 401, 403, 404, 422]) expect(classify(s)).toBe('skipped');
  });
});

describe('ResendEmail', () => {
  it('sends with an idempotency key and returns the provider id', async () => {
    const f = respond(200, { id: 'em_1' });
    const r = await new ResendEmail(KEY, 'School <no-reply@example.com>', f).send('a@example.com', msg);
    expect(r).toEqual({ outcome: 'sent', providerId: 'em_1' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init!.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('d-1');
    expect(JSON.parse(init!.body as string)).toMatchObject({ to: ['a@example.com'], subject: 'S', text: 'T' });
  });

  it('maps failures without leaking the key', async () => {
    for (const [status, outcome] of [
      [429, 'error'],
      [500, 'error'],
      [422, 'skipped'],
    ] as const) {
      const r = await new ResendEmail(KEY, 'x@example.com', respond(status)).send('a@example.com', msg);
      expect(r.outcome).toBe(outcome);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
    const net = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${KEY}`));
    const r = await new ResendEmail(KEY, 'x@example.com', net).send('a@example.com', msg);
    expect(r.outcome).toBe('error');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe('TelegramBot', () => {
  it('sends to the chat and never puts the token into the error', async () => {
    const ok = respond(200, { ok: true, result: { message_id: 42 } });
    expect(await new TelegramBot(TOKEN, ok).send('777', msg)).toEqual({ outcome: 'sent', providerId: '42' });
    expect(JSON.parse(ok.mock.calls[0]![1]!.body as string)).toMatchObject({ chat_id: '777' });
    const blocked = await new TelegramBot(TOKEN, respond(403)).send('777', msg);
    expect(blocked.outcome).toBe('skipped');
    expect(JSON.stringify(blocked)).not.toContain(TOKEN);
  });
});

describe('configuredChannels', () => {
  it('is off by default and when configuration is incomplete', () => {
    expect(configuredChannels({})).toMatchObject({ email: null, telegram: null, problems: [] });
    const partial = configuredChannels({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY });
    expect(partial.email).toBeNull();
    expect(partial.problems).toEqual(['RESEND_API_KEY/EMAIL_FROM']);
    const bad = configuredChannels({ TELEGRAM_BOT_TOKEN: 'not-a-token' });
    expect(bad.telegram).toBeNull();
    expect(bad.problems).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(JSON.stringify(bad)).not.toContain('not-a-token');
  });

  it('enables channels that are fully configured', () => {
    const c = configuredChannels({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'no-reply@example.com', TELEGRAM_BOT_TOKEN: TOKEN });
    expect(c.email?.name).toBe('email');
    expect(c.telegram?.name).toBe('telegram');
    expect(c.problems).toEqual([]);
  });
});
