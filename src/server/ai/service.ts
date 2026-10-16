import { costMicroUsd, reserveMicroUsd } from './pricing';
import { AiError, type AiErrorCode, type AiProvider, type AiRequest, type AiUsage } from './types';

/** Учёт обращений: резерв и итог. Реализация — БД (ai_begin / ai_finish), в тестах — заглушка. */
export interface AiLedger {
  begin(organizationId: string, feature: AiRequest['feature'], reserveMicroUsd: number): Promise<string>;
  finish(callId: string, status: CallStatus, usage: AiUsage | null, costMicroUsd: number, errorCode?: string): Promise<void>;
}

export type CallStatus = 'ok' | 'error' | 'timeout' | 'refused' | 'unavailable' | 'invalid_output';

export const MAX_INPUT_CHARS = 16_000;

const statusOf = (code: AiErrorCode): CallStatus =>
  code === 'ai_timeout' ? 'timeout' : code === 'ai_refused' ? 'refused' : code === 'ai_invalid_output' ? 'invalid_output' : code === 'ai_unavailable' ? 'unavailable' : 'error';

export interface AiRun<T> {
  callId: string;
  output: T;
  usage: AiUsage;
}

/**
 * Один вызов AI: проверка размера → резерв в БД (лимиты, бюджет) → провайдер с тайм-аутом →
 * фактический расход. Любая ошибка провайдера закрывает вызов в журнале и превращается в AiError.
 */
export async function runAi<T>(
  deps: { provider: AiProvider | null; ledger: AiLedger; log?: (msg: string, meta: Record<string, unknown>) => void },
  organizationId: string,
  request: AiRequest<T>,
): Promise<AiRun<T>> {
  if (!deps.provider) throw new AiError('ai_disabled');
  const chars = request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_INPUT_CHARS) throw new AiError('ai_input_too_long');

  const callId = await deps.ledger.begin(organizationId, request.feature, reserveMicroUsd(deps.provider.model, chars, request.maxOutputTokens));
  try {
    const result = await deps.provider.complete(request);
    await closeCall(deps, callId, 'ok', result.usage);
    return { callId, output: result.output, usage: result.usage };
  } catch (error) {
    const code: AiErrorCode = error instanceof AiError ? error.code : 'ai_unavailable';
    const usage = error && typeof error === 'object' && 'usage' in error ? ((error as { usage: AiUsage | null }).usage ?? null) : null;
    await closeCall(deps, callId, statusOf(code), usage, code);
    throw error instanceof AiError ? error : new AiError('ai_unavailable');
  }
}

async function closeCall(
  deps: { ledger: AiLedger; log?: (msg: string, meta: Record<string, unknown>) => void },
  callId: string,
  status: CallStatus,
  usage: AiUsage | null,
  errorCode?: string,
) {
  const cost = usage ? costMicroUsd(usage.model, usage.inputTokens, usage.outputTokens) : 0;
  try {
    await deps.ledger.finish(callId, status, usage, cost, errorCode);
  } catch (e) {
    // Незакрытый вызов остаётся «pending» и 15 минут учитывается в бюджете по резерву.
    deps.log?.('ai call finish failed', { callId, error: e instanceof Error ? e.message : String(e) });
  }
}
