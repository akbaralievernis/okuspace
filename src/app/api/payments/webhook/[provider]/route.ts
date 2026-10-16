import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { MAX_BODY_BYTES, PaymentEventSchema, SIGNATURE_HEADER, sha256, verifySignature } from '@/server/finance/webhook';
import { createPrivilegedClient } from '@/server/supabase/server';

export const dynamic = 'force-dynamic';

const envSchema = z.object({
  PAYMENT_PROVIDER: z.string().regex(/^[a-z0-9_]{2,40}$/),
  PAYMENT_WEBHOOK_SECRET: z.string().min(32),
});

/**
 * Приём событий платёжного провайдера. Без настроенного провайдера — 404.
 * Порядок: размер тела → подпись (по сырому телу) → схема → запись в БД функцией
 * record_provider_payment (идемпотентно: повтор события не создаёт второй платёж).
 * На отклонённые по сути события отвечаем 200, чтобы провайдер не повторял их бесконечно.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const env = envSchema.safeParse({ PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER, PAYMENT_WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET });
  const { provider } = await params;
  if (!env.success || provider !== env.data.PAYMENT_PROVIDER) return new NextResponse(null, { status: 404 });

  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  const sig = verifySignature(body, request.headers.get(SIGNATURE_HEADER), env.data.PAYMENT_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
  if (!sig.ok) {
    logger.warn('payment webhook signature rejected', { provider, reason: sig.reason });
    return new NextResponse(null, { status: 401 });
  }

  let event;
  try {
    event = PaymentEventSchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const { data, error } = await createPrivilegedClient().rpc('record_provider_payment', {
    p_provider: provider,
    p_event_id: event.eventId,
    p_payload_sha256: sha256(body),
    p_invoice: event.invoiceId,
    p_amount: event.amount,
    p_currency: event.currency,
    p_provider_ref: event.operationId,
    p_paid_at: event.paidAt ?? null,
  });
  if (error) {
    // Временная ошибка — провайдер повторит; повтор безопасен (идемпотентность в БД).
    logger.error('payment webhook processing failed', { provider, code: error.code });
    return new NextResponse(null, { status: 503 });
  }
  const outcome = (data as { outcome: string }).outcome;
  if (outcome === 'rejected') logger.warn('payment webhook event rejected', { provider, eventId: event.eventId });
  return NextResponse.json({ outcome }, { headers: { 'cache-control': 'no-store' } });
}
