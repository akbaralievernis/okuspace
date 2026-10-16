import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '@/server/ai/anthropic';
import { WritingCheckOutput, vetWritingCheck } from '@/server/ai/outputs';
import { writingCheckSystem } from '@/server/ai/prompts';
import { costMicroUsd, microToUsd } from '@/server/ai/pricing';
import { WRITING_CASES, scoreCase, summarize, type CaseScore } from './writing-cases';

/**
 * Прогон качества на настоящей модели. Тратит деньги: запускается только явно
 * (`npm run eval:ai`) и только при ANTHROPIC_API_KEY. Без ключа — пропуск, не «успех».
 */
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.AI_MODEL || 'claude-opus-5-5';

describe.skipIf(!key)(`writing feedback quality (${model})`, () => {
  it(
    'finds known mistakes, does not invent mistakes in clean texts, passes the quality guard',
    async () => {
      const provider = new AnthropicProvider(key!, model);
      const scores: CaseScore[] = [];
      let rejected = 0;
      let cost = 0;
      for (const c of WRITING_CASES) {
        const r = await provider.complete({
          feature: 'writing_check',
          system: writingCheckSystem({ targetLanguage: c.targetLanguage, level: c.level, uiLanguage: 'ru' }),
          messages: [{ role: 'user', content: `Learner text:\n<<<\n${c.text}\n>>>` }],
          maxOutputTokens: 3000,
          schema: WritingCheckOutput,
          timeoutMs: 60_000,
        });
        cost += costMicroUsd(r.usage.model, r.usage.inputTokens, r.usage.outputTokens);
        const vetted = vetWritingCheck(c.text, r.output);
        if (!vetted) rejected += 1;
        const s = scoreCase(c, (vetted?.result ?? r.output).corrections.map((x) => x.original));
        scores.push(s);
        // Каждое исправление обязано иметь объяснение.
        for (const x of r.output.corrections) expect(x.explanation.trim().length, c.id).toBeGreaterThan(0);
      }
      const summary = summarize(scores, rejected);
      console.warn(JSON.stringify({ model, cost_usd: microToUsd(cost), ...summary, scores }, null, 2));
      expect(summary.passed).toBe(true);
    },
    600_000,
  );
});
