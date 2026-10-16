import { describe, expect, it } from 'vitest';
import { vetWritingCheck } from '@/server/ai/outputs';
import { WRITING_CASES, scoreCase, summarize } from '../../ai-eval/writing-cases';

/**
 * Сам набор примеров и его подсчёт проверяются без модели: примеры корректны,
 * идеальный отзыв проходит порог, плохой — нет.
 */
describe('writing quality eval set', () => {
  it('cases are well-formed: unique ids, expected fragments are really in the text, no personal data', () => {
    expect(new Set(WRITING_CASES.map((c) => c.id)).size).toBe(WRITING_CASES.length);
    for (const c of WRITING_CASES) {
      for (const f of c.mustFind) expect(c.text.toLowerCase(), c.id).toContain(f.toLowerCase());
      expect(c.text, c.id).not.toMatch(/@|\+\d{3}|\d{6,}/);
    }
    expect(WRITING_CASES.filter((c) => c.mustFind.length === 0).length).toBeGreaterThanOrEqual(3);
  });

  it('a perfect answer passes the threshold and survives the quality guard', () => {
    const scores = WRITING_CASES.map((c) => {
      const out = { summary: 's', corrections: c.mustFind.map((f) => ({ original: f, suggestion: `${f}!`, explanation: 'rule', category: 'grammar' as const })), strengths: [], uncertainty: '' };
      const vetted = vetWritingCheck(c.text, out);
      expect(vetted, c.id).not.toBeNull();
      return scoreCase(c, vetted!.result.corrections.map((x) => x.original));
    });
    expect(summarize(scores, 0)).toEqual({ recall: 1, cleanFalsePositives: 0, rejected: 0, passed: true });
  });

  it('missing mistakes or inventing them in clean texts fails the threshold', () => {
    const lazy = WRITING_CASES.map((c) => scoreCase(c, c.mustFind.slice(0, 1)));
    expect(summarize(lazy, 0).passed).toBe(false);
    const noisy = WRITING_CASES.map((c) => scoreCase(c, c.mustFind.length ? c.mustFind : ['I have been', 'reading', 'films']));
    expect(summarize(noisy, 0)).toMatchObject({ recall: 1, cleanFalsePositives: 3, passed: false });
    const perfect = WRITING_CASES.map((c) => scoreCase(c, c.mustFind));
    expect(summarize(perfect, 1).passed).toBe(false);
  });
});
