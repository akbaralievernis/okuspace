import { z } from 'zod';

/**
 * Схемы структурированных ответов модели. Ответ, не прошедший схему, не показывается
 * и не сохраняется (ai_invalid_output). Каждая оценка сопровождается объяснением.
 */
export const CORRECTION_CATEGORIES = ['grammar', 'vocabulary', 'spelling', 'punctuation', 'word_order', 'style'] as const;

export const WritingCheckOutput = z.object({
  summary: z.string().min(1).max(1500),
  corrections: z
    .array(
      z.object({
        original: z.string().min(1).max(500),
        suggestion: z.string().min(1).max(500),
        explanation: z.string().min(1).max(800),
        category: z.enum(CORRECTION_CATEGORIES),
      }),
    )
    .max(30),
  strengths: z.array(z.string().min(1).max(300)).max(5),
  // Модель сама отмечает, в чём не уверена, — показываем ученику рядом с отзывом.
  uncertainty: z.string().max(500),
});
export type WritingCheck = z.infer<typeof WritingCheckOutput>;

export const GrammarOutput = z.object({
  explanation: z.string().min(1).max(4000),
  examples: z.array(z.object({ sentence: z.string().min(1).max(300), note: z.string().max(300) })).min(1).max(8),
  commonMistakes: z.array(z.string().min(1).max(300)).max(5),
});
export type GrammarAnswer = z.infer<typeof GrammarOutput>;

export const ExercisesOutput = z.object({
  exercises: z
    .array(
      z.object({
        id: z.string().regex(/^e\d{1,2}$/),
        prompt: z.string().min(1).max(500),
        accepted: z.array(z.string().min(1).max(200)).min(1).max(5),
        hint: z.string().max(300),
        explanation: z.string().min(1).max(600),
        category: z.enum(CORRECTION_CATEGORIES),
      }),
    )
    .min(1)
    .max(10)
    .refine((list) => new Set(list.map((e) => e.id)).size === list.length, { message: 'duplicate ids' }),
});
export type Exercises = z.infer<typeof ExercisesOutput>;

/**
 * Проверка качества каждого отзыва о письме (без второго вызова модели):
 * исправление принимается, только если исходный фрагмент действительно есть в тексте
 * ученика и отличается от предложенного. Если отброшено больше половины исправлений,
 * отзыв считается ненадёжным и не показывается.
 */
export function vetWritingCheck(input: string, output: WritingCheck): { result: WritingCheck; dropped: number } | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const text = norm(input);
  // Фрагмент должен стоять в тексте целыми словами: «apple» не найден в «apples».
  const quoted = (fragment: string) => {
    const escaped = norm(fragment).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
  };
  const kept = output.corrections.filter((c) => quoted(c.original) && norm(c.original) !== norm(c.suggestion));
  const dropped = output.corrections.length - kept.length;
  if (output.corrections.length > 0 && dropped * 2 > output.corrections.length) return null;
  return { result: { ...output, corrections: kept }, dropped };
}

/** Упражнение пригодно, если ответ можно проверить точным совпадением и он не подсказан в задании. */
export function vetExercises(output: Exercises): Exercises | null {
  const usable = output.exercises.filter((e) => e.accepted.every((a) => a.trim().length > 0 && a.length <= 60) && !e.accepted.some((a) => e.prompt.toLowerCase().includes(`(${a.toLowerCase()})`)));
  return usable.length ? { exercises: usable } : null;
}
