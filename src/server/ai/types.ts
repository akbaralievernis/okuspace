import type { z } from 'zod';

/**
 * Единый интерфейс AI-провайдера. Платформа зависит только от него: замена провайдера —
 * новая реализация AiProvider, без изменений в функциях AI Lab, лимитах и учёте (ADR-0009).
 */
export type AiFeature = 'conversation' | 'writing_check' | 'grammar' | 'exercises';

/** Причины, понятные пользователю. Детали провайдера в интерфейс не попадают. */
export type AiErrorCode =
  | 'ai_disabled' // школа не включила AI или провайдер не настроен
  | 'ai_unavailable' // провайдер недоступен / ошибка сервера / сеть
  | 'ai_timeout'
  | 'ai_rate_limited' // слишком часто (наш лимит или лимит провайдера)
  | 'ai_daily_limit'
  | 'ai_budget' // месячный бюджет школы исчерпан
  | 'ai_refused' // модель отказалась отвечать
  | 'ai_invalid_output' // ответ не прошёл проверку схемы
  | 'ai_input_too_long';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AiError';
  }
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest<T = string> {
  feature: AiFeature;
  system: string;
  messages: AiMessage[];
  maxOutputTokens: number;
  /** Схема структурированного ответа; без неё — свободный текст. */
  schema?: z.ZodType<T>;
  timeoutMs: number;
}

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiResponse<T = string> {
  output: T;
  usage: AiUsage;
}

/** Ошибка провайдера с учётом расхода (если запрос успел потратить токены). */
export class AiProviderError extends AiError {
  constructor(
    code: AiErrorCode,
    readonly usage: AiUsage | null,
    message?: string,
  ) {
    super(code, message);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete<T>(request: AiRequest<T>): Promise<AiResponse<T>>;
}
