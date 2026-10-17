import type { Channel, SendResult } from './channels';
import { emailBody, renderNotification } from './render';

/**
 * Обработчик очереди доставки: захватить пачку → собрать текст на языке получателя →
 * отправить с тайм-аутом → записать итог. Любая ошибка одной доставки не останавливает
 * остальные и не затрагивает основное действие (оно записано раньше, в своей транзакции).
 */
export interface QueueItem {
  id: string;
  channel: 'email' | 'telegram';
  attempts: number;
  kind: string;
  payload: Record<string, unknown>;
  locale: string | null;
  address: string | null;
}

export interface QueueStore {
  claim(limit: number): Promise<QueueItem[]>;
  complete(id: string, outcome: SendResult['outcome'], providerId: string | null, error: string | null): Promise<void>;
}

export interface WorkerResult {
  processed: number;
  sent: number;
  retry: number;
  skipped: number;
}

export async function processDeliveries(
  deps: { store: QueueStore; channels: { email: Channel | null; telegram: Channel | null }; appUrl: string; log?: (msg: string, meta: Record<string, unknown>) => void },
  limit = 50,
): Promise<WorkerResult> {
  const items = await deps.store.claim(limit);
  const result: WorkerResult = { processed: items.length, sent: 0, retry: 0, skipped: 0 };
  for (const item of items) {
    let outcome: SendResult;
    const channel = deps.channels[item.channel];
    if (!channel) outcome = { outcome: 'skipped', error: 'channel not configured' };
    else if (!item.address) outcome = { outcome: 'skipped', error: 'no address' };
    else {
      try {
        const rendered = renderNotification(item.kind, item.payload ?? {}, item.locale);
        const body = emailBody(rendered, item.locale, deps.appUrl);
        outcome = await channel.send(item.address, { ...body, idempotencyKey: item.id });
      } catch (e) {
        outcome = { outcome: 'error', error: `unexpected: ${e instanceof Error ? e.name : 'error'}` };
      }
    }
    try {
      await deps.store.complete(item.id, outcome.outcome, outcome.outcome === 'sent' ? outcome.providerId : null, outcome.outcome === 'sent' ? null : outcome.error);
    } catch (e) {
      // Незавершённая доставка через 10 минут будет захвачена снова (повтор ограничен счётчиком попыток).
      deps.log?.('delivery completion failed', { id: item.id, error: e instanceof Error ? e.message : String(e) });
    }
    if (outcome.outcome === 'sent') result.sent += 1;
    else if (outcome.outcome === 'skipped') result.skipped += 1;
    else result.retry += 1;
  }
  return result;
}
