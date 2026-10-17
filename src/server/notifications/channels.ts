import 'server-only';

import { z } from 'zod';

/**
 * Каналы доставки. Ключи провайдеров — только серверные переменные; без настройки канал
 * не используется (доставки помечаются «пропущено»). Ответы провайдера наружу не передаются:
 * в журнал попадает короткая причина без секретов.
 */
export type SendResult = { outcome: 'sent'; providerId: string | null } | { outcome: 'error' | 'skipped'; error: string };

export interface Channel {
  readonly name: 'email' | 'telegram';
  send(to: string, message: { subject: string; text: string; idempotencyKey: string }): Promise<SendResult>;
}

const TIMEOUT_MS = 10_000;

/** HTTP-ответ провайдера → исход: 429/5xx/сеть — повторить позже, остальные 4xx — постоянная ошибка. */
export function classify(status: number): 'sent' | 'error' | 'skipped' {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 429 || status >= 500 || status === 408) return 'error';
  return 'skipped';
}

async function post(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response | { networkError: string }> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { networkError: e instanceof Error ? e.name : 'network' };
  }
}

/** Email через Resend (HTTP API). Ключ идемпотентности = id доставки: повтор не отправит письмо дважды. */
export class ResendEmail implements Channel {
  readonly name = 'email' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, m: { subject: string; text: string; idempotencyKey: string }): Promise<SendResult> {
    const res = await post(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': m.idempotencyKey },
        body: JSON.stringify({ from: this.from, to: [to], subject: m.subject, text: m.text }),
      },
      this.fetchImpl,
    );
    if ('networkError' in res) return { outcome: 'error', error: `network: ${res.networkError}` };
    const outcome = classify(res.status);
    if (outcome === 'sent') {
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { outcome, providerId: typeof body.id === 'string' ? body.id : null };
    }
    return { outcome, error: `resend http ${res.status}` };
  }
}

/** Telegram Bot API: sendMessage в привязанный чат. */
export class TelegramBot implements Channel {
  readonly name = 'telegram' as const;
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(chatId: string, m: { subject: string; text: string }): Promise<SendResult> {
    const res = await post(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: `${m.subject}\n\n${m.text}`, disable_web_page_preview: true }) },
      this.fetchImpl,
    );
    if ('networkError' in res) return { outcome: 'error', error: `network: ${res.networkError}` };
    const outcome = classify(res.status);
    if (outcome === 'sent') {
      const body = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
      return { outcome, providerId: body.result?.message_id ? String(body.result.message_id) : null };
    }
    // Токен в URL не попадает в журнал — пишем только код ответа.
    return { outcome, error: `telegram http ${res.status}` };
  }
}

const envSchema = z.object({
  EMAIL_PROVIDER: z.enum(['resend', 'none']).default('none'),
  RESEND_API_KEY: z.string().min(10).optional(),
  EMAIL_FROM: z.string().min(3).optional(),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/).optional(),
});

/** Настроенные каналы. Неполная настройка = канал выключен (имена переменных — в лог, значения — никогда). */
export function configuredChannels(env: Record<string, string | undefined> = process.env): { email: Channel | null; telegram: Channel | null; problems: string[] } {
  const parsed = envSchema.safeParse({
    EMAIL_PROVIDER: env.EMAIL_PROVIDER || undefined,
    RESEND_API_KEY: env.RESEND_API_KEY || undefined,
    EMAIL_FROM: env.EMAIL_FROM || undefined,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || undefined,
  });
  if (!parsed.success) return { email: null, telegram: null, problems: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] };
  const v = parsed.data;
  const problems: string[] = [];
  let email: Channel | null = null;
  if (v.EMAIL_PROVIDER === 'resend') {
    if (v.RESEND_API_KEY && v.EMAIL_FROM) email = new ResendEmail(v.RESEND_API_KEY, v.EMAIL_FROM);
    else problems.push('RESEND_API_KEY/EMAIL_FROM');
  }
  return { email, telegram: v.TELEGRAM_BOT_TOKEN ? new TelegramBot(v.TELEGRAM_BOT_TOKEN) : null, problems };
}
