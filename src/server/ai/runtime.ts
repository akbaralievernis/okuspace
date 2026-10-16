import 'server-only';

import { z } from 'zod';
import { logger } from '@/lib/logger';
import { createPrivilegedClient, createUserClient } from '@/server/supabase/server';
import { AnthropicProvider } from './anthropic';
import type { AiLedger } from './service';
import { AiError, type AiProvider } from './types';

/**
 * Конфигурация AI — только серверные переменные. Без AI_PROVIDER=anthropic и ключа AI выключен,
 * а обучение работает как обычно (ADR-0009).
 */
const aiEnvSchema = z.discriminatedUnion('AI_PROVIDER', [
  z.object({ AI_PROVIDER: z.literal('none') }),
  z.object({
    AI_PROVIDER: z.literal('anthropic'),
    ANTHROPIC_API_KEY: z.string().min(20),
    AI_MODEL: z.string().regex(/^claude-[a-z0-9-]+$/).default('claude-opus-5-5'),
  }),
]);

let cached: AiProvider | null | undefined;

export function getAiProvider(): AiProvider | null {
  if (cached !== undefined) return cached;
  const parsed = aiEnvSchema.safeParse({
    AI_PROVIDER: process.env.AI_PROVIDER || 'none',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AI_MODEL: process.env.AI_MODEL || undefined,
  });
  if (!parsed.success) {
    // Имена переменных — да, значения — никогда.
    logger.error('AI provider misconfigured; AI disabled', { keys: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] });
    cached = null;
  } else {
    cached = parsed.data.AI_PROVIDER === 'anthropic' ? new AnthropicProvider(parsed.data.ANTHROPIC_API_KEY, parsed.data.AI_MODEL) : null;
  }
  return cached;
}

const BEGIN_ERRORS: [string, AiError['code']][] = [
  ['ai disabled', 'ai_disabled'],
  ['ai rate limited', 'ai_rate_limited'],
  ['ai daily limit', 'ai_daily_limit'],
  ['ai budget exceeded', 'ai_budget'],
];

/** Журнал вызовов в БД: резерв — от имени пользователя (RLS, лимиты), итог — только сервер. */
export const dbLedger: AiLedger = {
  async begin(organizationId, feature, reserve) {
    const db = await createUserClient();
    const { data, error } = await db.rpc('ai_begin', { p_org: organizationId, p_feature: feature, p_reserve_micro_usd: reserve });
    if (error) {
      const hit = BEGIN_ERRORS.find(([m]) => error.message?.includes(m));
      if (hit) throw new AiError(hit[1]);
      if (error.code === '42501') throw new AiError('ai_disabled');
      logger.error('ai_begin failed', { code: error.code });
      throw new AiError('ai_unavailable');
    }
    return data as string;
  },
  async finish(callId, status, usage, cost, errorCode) {
    const { error } = await createPrivilegedClient().rpc('ai_finish', {
      p_call: callId,
      p_status: status,
      p_model: usage?.model ?? null,
      p_input_tokens: usage?.inputTokens ?? null,
      p_output_tokens: usage?.outputTokens ?? null,
      p_cost_micro_usd: cost,
      p_error_code: errorCode ?? null,
    });
    if (error) throw new Error(`ai_finish failed: ${error.code}`);
  },
};

export const aiDeps = () => ({ provider: getAiProvider(), ledger: dbLedger, log: (msg: string, meta: Record<string, unknown>) => logger.error(msg, meta) });
