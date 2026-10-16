import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as LoggerNs from '@/lib/logger';

type LoggerModule = typeof LoggerNs;

/** Конфигурация провайдера: без явной настройки AI выключен; секрет не попадает в логи. */
const SECRET = 'fake-test-value-for-anthropic-key-000000';

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  const logs: unknown[] = [];
  vi.doMock('@/lib/logger', async (original) => ({
    ...(await original<LoggerModule>()),
    logger: { error: (...args: unknown[]) => logs.push(args), info: () => {}, warn: () => {}, debug: () => {} },
  }));
  const mod = await import('@/server/ai/runtime');
  return { provider: mod.getAiProvider(), logs };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/logger');
});

describe('getAiProvider', () => {
  it('is off by default (no AI_PROVIDER)', async () => {
    expect((await load({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: SECRET })).provider).toBeNull();
  });

  it('turns on with an explicit provider and key; default model is claude-opus-5-5', async () => {
    const { provider } = await load({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: SECRET, AI_MODEL: undefined });
    expect(provider).toMatchObject({ name: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('a missing key or an unknown provider disables AI and logs variable names, never values', async () => {
    for (const env of [
      { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: undefined },
      { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: SECRET, AI_MODEL: 'gpt-4o' },
      { AI_PROVIDER: 'other', ANTHROPIC_API_KEY: SECRET },
    ]) {
      const { provider, logs } = await load(env);
      expect(provider, JSON.stringify(Object.keys(env))).toBeNull();
      expect(JSON.stringify(logs)).not.toContain(SECRET);
      expect(JSON.stringify(logs)).toContain('AI provider misconfigured');
    }
  });
});
