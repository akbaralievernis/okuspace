import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Подпись webhook платёжного провайдера (общая HMAC-схема, ADR-0011):
 *   заголовок `x-okuspace-signature: t=<unix-секунды>,v1=<hex HMAC-SHA256(secret, "<t>.<тело>")>`.
 * Проверяем подпись по сырому телу, сравнение — за постоянное время, метка времени —
 * не старше 5 минут (защита от повторной отправки перехваченного запроса).
 * Конкретный провайдер подключается адаптером, который приводит его формат к этой схеме.
 */
export const SIGNATURE_HEADER = 'x-okuspace-signature';
export const TOLERANCE_SECONDS = 300;
export const MAX_BODY_BYTES = 64 * 1024;

export function sign(body: string, secret: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export type SignatureResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

export function verifySignature(body: string, header: string | null, secret: string, nowSeconds: number): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' };
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return { ok: false, reason: 'expired' };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex'), 'hex');
  const given = Buffer.from(v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Тело события «платёж прошёл». Сумма — строкой, не числом (без float). */
export const PaymentEventSchema = z.object({
  type: z.literal('payment.succeeded'),
  eventId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  invoiceId: z.uuid(),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  paidAt: z.iso.datetime({ offset: true }).optional(),
});
export type PaymentEvent = z.infer<typeof PaymentEventSchema>;

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
