import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { configuredChannels } from '@/server/notifications/channels';
import { bearerMatches } from '@/server/notifications/secret';
import { processDeliveries, type QueueItem } from '@/server/notifications/worker';
import { createPrivilegedClient } from '@/server/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Плановые задачи (Vercel Cron или любой планировщик с секретом CRON_SECRET):
 *  1) уведомления по расписанию (напоминания, оплата, еженедельный отчёт, просроченные задачи) — без дублей;
 *  2) доставка очереди во внешние каналы — статусы, повторы, ошибки;
 *  3) удаление по срокам хранения (мониторинг; контакты CRM — 24 месяца без активности).
 * Каждая задача независима: сбой одной не отменяет остальные.
 */
export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get('authorization'), process.env.CRON_SECRET)) return new NextResponse(null, { status: 401 });
  const db = createPrivilegedClient();
  const summary: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      summary[name] = await fn();
    } catch (e) {
      logger.error('cron step failed', { step: name, error: e instanceof Error ? e.message : String(e) });
      summary[name] = { error: true };
    }
  };

  await step('scheduled', async () => {
    const { data, error } = await db.rpc('generate_scheduled_notifications', {});
    if (error) throw new Error(error.code);
    return data;
  });
  await step('tasks', async () => {
    const { data, error } = await db.rpc('generate_task_reminders', {});
    if (error) throw new Error(error.code);
    return data;
  });
  await step('deliveries', async () => {
    const channels = configuredChannels();
    if (channels.problems.length) logger.warn('notification channels misconfigured', { keys: channels.problems });
    return processDeliveries({
      channels,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? '',
      log: (msg, meta) => logger.error(msg, meta),
      store: {
        async claim(limit) {
          const { data, error } = await db.rpc('claim_deliveries', { p_limit: limit });
          if (error) throw new Error(error.code);
          return (data ?? []) as QueueItem[];
        },
        async complete(id, outcome, providerId, err) {
          const { error } = await db.rpc('complete_delivery', { p_id: id, p_outcome: outcome, p_provider_id: providerId, p_error: err });
          if (error) throw new Error(error.code);
        },
      },
    });
  });
  await step('monitoringRetention', async () => (await db.rpc('monitoring_purge')).data);
  await step('crmRetention', async () => (await db.rpc('crm_purge_stale', { p_months: 24 })).data);

  return NextResponse.json(summary, { headers: { 'cache-control': 'no-store' } });
}
