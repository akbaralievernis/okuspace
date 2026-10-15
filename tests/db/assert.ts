import { expect } from 'vitest';

export const RLS_DENIED = /row-level security|permission denied/i;

/** Операция должна быть отклонена (RLS, привилегии или триггер целостности). */
export async function expectDenied(promise: Promise<unknown>, pattern: RegExp = RLS_DENIED): Promise<void> {
  await expect(promise).rejects.toThrow(pattern);
}
