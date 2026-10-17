import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { configuredChannels } from '@/server/notifications/channels';
import { safeEqual } from '@/server/notifications/secret';
import { createPrivilegedClient } from '@/server/supabase/server';

export const dynamic = 'force-dynamic';

const UpdateSchema = z.object({
  message: z.object({ chat: z.object({ id: z.number() }), text: z.string().max(200).optional() }).optional(),
});

/**
 * Обновления Telegram-бота. Проверяется секретный заголовок, заданный при setWebhook.
 * Бот умеет только одно: привязать чат по одноразовому коду (/start КОД). Никаких действий
 * в платформе через бота не выполняется.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const given = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!secret || secret.length < 32 || !safeEqual(given, secret)) {
    return new NextResponse(null, { status: 401 });
  }
  const body = await request.text();
  if (body.length > 16_384) return new NextResponse(null, { status: 413 });
  let update;
  try {
    update = UpdateSchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ ok: true }); // нерелевантные обновления игнорируем
  }
  const text = update.message?.text?.trim() ?? '';
  const chatId = update.message?.chat.id;
  const m = /^\/start\s+([0-9A-Fa-f]{10})$/.exec(text);
  if (!chatId || !m) return NextResponse.json({ ok: true });

  let linked = false;
  try {
    const { data, error } = await createPrivilegedClient().rpc('link_telegram', { p_code: m[1], p_chat_id: String(chatId) });
    if (error) throw new Error(error.code);
    linked = data === true;
  } catch (e) {
    logger.error('telegram link failed', { error: e instanceof Error ? e.message : String(e) });
  }
  const bot = configuredChannels().telegram;
  await bot
    ?.send(String(chatId), { subject: 'Okuspace', text: linked ? '✓ Уведомления подключены / Notifications connected.' : 'Код неверный или устарел / Invalid or expired code.', idempotencyKey: '' })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
}
