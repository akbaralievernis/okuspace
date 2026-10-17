import { describe, expect, it, vi } from 'vitest';
import type { Channel, SendResult } from '@/server/notifications/channels';
import { processDeliveries, type QueueItem, type QueueStore } from '@/server/notifications/worker';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: crypto.randomUUID(),
  channel: 'email',
  attempts: 1,
  kind: 'payment_due',
  payload: { number: 'N-1', dueOn: '2026-10-19', outstanding: '10.00', currency: 'KGS' },
  locale: 'ru',
  address: 'a@example.com',
  ...over,
});

function setup(items: QueueItem[], send: (to: string) => Promise<SendResult>) {
  const completed: [string, string, string | null, string | null][] = [];
  const store: QueueStore = {
    claim: vi.fn(async () => items),
    complete: vi.fn(async (id, outcome, providerId, error) => {
      completed.push([id, outcome, providerId, error]);
    }),
  };
  const channel: Channel = { name: 'email', send: vi.fn((to: string) => send(to)) };
  return { store, channel, completed };
}

describe('processDeliveries', () => {
  it('records the outcome of every delivery and passes the delivery id as idempotency key', async () => {
    const a = item();
    const b = item({ address: 'fail@example.com' });
    const c = item({ address: 'bad@example.com' });
    const { store, channel, completed } = setup([a, b, c], async (to) =>
      to === 'a@example.com'
        ? { outcome: 'sent', providerId: 'p1' }
        : to === 'fail@example.com'
          ? { outcome: 'error', error: 'resend http 500' }
          : { outcome: 'skipped', error: 'resend http 422' },
    );
    const r = await processDeliveries({ store, channels: { email: channel, telegram: null }, appUrl: 'https://x.example' });
    expect(r).toEqual({ processed: 3, sent: 1, retry: 1, skipped: 1 });
    expect(completed).toEqual([
      [a.id, 'sent', 'p1', null],
      [b.id, 'error', null, 'resend http 500'],
      [c.id, 'skipped', null, 'resend http 422'],
    ]);
    expect(vi.mocked(channel.send).mock.calls[0]![1]).toMatchObject({ idempotencyKey: a.id, subject: expect.stringContaining('Okuspace') });
  });

  it('skips unconfigured channels and missing addresses without calling a provider', async () => {
    const { store, channel, completed } = setup([item({ channel: 'telegram' }), item({ address: null })], async () => ({ outcome: 'sent', providerId: null }));
    const r = await processDeliveries({ store, channels: { email: channel, telegram: null }, appUrl: '' });
    expect(r).toEqual({ processed: 2, sent: 0, retry: 0, skipped: 2 });
    expect(completed.map((x) => x[3])).toEqual(['channel not configured', 'no address']);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('a throwing provider or a failed completion does not stop the batch', async () => {
    const items = [item(), item()];
    const { store, channel } = setup(items, async () => {
      throw new Error('boom secret');
    });
    vi.mocked(store.complete).mockRejectedValueOnce(new Error('db down'));
    const log = vi.fn();
    const r = await processDeliveries({ store, channels: { email: channel, telegram: null }, appUrl: '', log });
    expect(r).toEqual({ processed: 2, sent: 0, retry: 2, skipped: 0 });
    expect(store.complete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.complete).mock.calls[1]![3]).toBe('unexpected: Error');
    expect(log).toHaveBeenCalledWith('delivery completion failed', expect.objectContaining({ id: items[0]!.id }));
  });
});
