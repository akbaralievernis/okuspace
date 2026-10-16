/**
 * Цены провайдера в долларах за 1 млн токенов = микродолларов за токен.
 * Расход храним целыми микродолларами (ai_calls.cost_micro_usd), без float в деньгах.
 * Источник: прайс Anthropic (кеш справочника SDK от 2026-10-06). Неизвестная модель
 * оценивается по самой дорогой цене — лимит не должен занижаться.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const FALLBACK_PRICE = { input: 10, output: 50 };

export function priceOf(model: string) {
  return PRICES[model] ?? FALLBACK_PRICE;
}

export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return Math.ceil(inputTokens * p.input + outputTokens * p.output);
}

/**
 * Резерв перед вызовом: оценка входа по длине текста (≈ 1 токен на 3 символа — с запасом
 * для кириллицы) + максимум выхода. Фактический расход записывается после ответа.
 */
export function reserveMicroUsd(model: string, inputChars: number, maxOutputTokens: number): number {
  const p = priceOf(model);
  const estimatedInput = Math.ceil(inputChars / 3) + 200;
  return Math.max(1, Math.ceil(estimatedInput * p.input + maxOutputTokens * p.output));
}

/** Доллары → микродоллары для формы настроек (точно, без float: строка '12.50'). */
export function usdToMicro(usd: string): number | null {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(usd.trim());
  if (!m) return null;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(2, '0')) * 10_000;
}

export function microToUsd(micro: number): string {
  const cents = Math.round(micro / 10_000);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
