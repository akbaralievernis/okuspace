import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AiProviderError, type AiError, type AiErrorCode, type AiProvider, type AiRequest, type AiResponse, type AiUsage } from './types';

/**
 * Провайдер Anthropic (Claude) через официальный SDK. Ключ — только серверная переменная.
 * Отказ модели по соображениям безопасности: включён серверный fallback по умолчанию
 * (`fallbacks: "default"`), итоговый отказ → ai_refused.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    /** Для тестов: подмена HTTP (fetch) без обращения к сети. */
    clientOptions: { fetch?: typeof fetch; maxRetries?: number } = {},
  ) {
    // Одна повторная попытка SDK на 429/5xx/сеть; общий срок задаёт timeout запроса.
    this.client = new Anthropic({ apiKey, maxRetries: 1, ...clientOptions });
  }

  async complete<T>(request: AiRequest<T>): Promise<AiResponse<T>> {
    const params = {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default' as const,
      // Учебные ответы короткие: низкое усилие — быстрее и дешевле; качество проверяется eval-набором.
      output_config: request.schema
        ? { effort: 'low' as const, format: betaZodOutputFormat(request.schema) }
        : { effort: 'low' as const },
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    let message;
    try {
      message = await this.client.beta.messages.parse(params, { timeout: request.timeoutMs });
    } catch (error) {
      throw mapError(error);
    }

    const usage: AiUsage = { model: message.model, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    if (message.stop_reason === 'refusal') throw new AiProviderError('ai_refused', usage);
    if (message.stop_reason === 'max_tokens') throw new AiProviderError('ai_invalid_output', usage, 'output truncated');

    if (request.schema) {
      if (message.parsed_output == null) throw new AiProviderError('ai_invalid_output', usage);
      return { output: message.parsed_output as T, usage };
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) throw new AiProviderError('ai_invalid_output', usage, 'empty answer');
    return { output: text as T, usage };
  }
}

/** Типизированные ошибки SDK → понятные коды. Сообщения провайдера наружу не передаются. */
function mapError(error: unknown): AiError {
  let code: AiErrorCode = 'ai_unavailable';
  if (error instanceof Anthropic.APIConnectionTimeoutError) code = 'ai_timeout';
  else if (error instanceof Anthropic.RateLimitError) code = 'ai_rate_limited';
  else if (error instanceof Anthropic.APIConnectionError) code = 'ai_unavailable';
  else if (error instanceof Anthropic.BadRequestError) code = 'ai_invalid_output';
  else if (error instanceof Anthropic.AnthropicError && /parse structured output/i.test(error.message)) code = 'ai_invalid_output';
  return new AiProviderError(code, null, error instanceof Error ? error.name : 'unknown');
}
