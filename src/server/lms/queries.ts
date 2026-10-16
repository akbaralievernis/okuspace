import 'server-only';

import { z } from 'zod';
import { logger } from '@/lib/logger';
import { createUserClient } from '@/server/supabase/server';

/** Ответы RPC LMS проверяются схемами — несовпадение формы даёт «недоступно», а не падение. */
export const ProgressSchema = z.object({
  lessonsTotal: z.number().int(),
  lessonsCompleted: z.number().int(),
  lastLessonId: z.uuid().nullable(),
  nextLessonId: z.uuid().nullable(),
  completedLessonIds: z.array(z.uuid()),
  assessments: z.array(z.object({ assessmentId: z.uuid(), bestScore: z.string(), maxScore: z.string(), attempts: z.number().int(), lastAt: z.string() })),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ReviewSchema = z.object({
  attemptId: z.uuid(),
  assessmentId: z.uuid(),
  attemptNo: z.number().int(),
  score: z.string(),
  maxScore: z.string(),
  submittedAt: z.string(),
  answersRevealed: z.boolean(),
  questions: z.array(
    z.object({
      id: z.uuid(),
      position: z.number().int(),
      type: z.enum(['single_choice', 'multiple_choice', 'short_text', 'gap_fill']),
      skill: z.string(),
      prompt: z.string(),
      options: z.array(z.object({ id: z.string(), text: z.string() })),
      points: z.string(),
      answer: z.record(z.string(), z.unknown()),
      isCorrect: z.boolean(),
      pointsAwarded: z.string(),
      key: z.record(z.string(), z.unknown()).nullable(),
      explanation: z.string().nullable(),
    }),
  ),
});
export type Review = z.infer<typeof ReviewSchema>;

export async function myLearningCourses(): Promise<{ id: string; title: string; studentId: string }[] | null> {
  const db = await createUserClient();
  const { data, error } = await db.rpc('my_learning_courses');
  if (error) {
    logger.error('my_learning_courses failed', { code: error.code });
    return null;
  }
  return ((data ?? []) as { id: string; title: string; student_id: string }[]).map((r) => ({ id: r.id, title: r.title, studentId: r.student_id }));
}

export async function courseProgress(courseId: string, studentId?: string): Promise<Progress | null> {
  const db = await createUserClient();
  const { data, error } = await db.rpc('course_progress', { p_course: courseId, p_student: studentId ?? null });
  if (error) return null;
  const parsed = ProgressSchema.safeParse(data);
  if (!parsed.success) logger.error('course_progress shape mismatch', { issues: parsed.error.issues.slice(0, 3) });
  return parsed.success ? parsed.data : null;
}

export async function attemptReview(attemptId: string): Promise<Review | null> {
  const db = await createUserClient();
  const { data, error } = await db.rpc('attempt_review', { p_attempt: attemptId });
  if (error) return null;
  const parsed = ReviewSchema.safeParse(data);
  if (!parsed.success) logger.error('attempt_review shape mismatch', { issues: parsed.error.issues.slice(0, 3) });
  return parsed.success ? parsed.data : null;
}

/** Текст ответа для показа: вариант(ы), строка, пропуски. */
export function describeAnswer(type: Review['questions'][number]['type'], value: Record<string, unknown> | null, options: { id: string; text: string }[]): string {
  if (!value) return '';
  const label = (id: unknown) => options.find((o) => o.id === id)?.text ?? String(id);
  switch (type) {
    case 'single_choice':
      return value.option === undefined ? '' : label(value.option);
    case 'multiple_choice':
      return Array.isArray(value.options) ? value.options.map(label).join(', ') : '';
    case 'short_text':
      return Array.isArray(value.accepted) ? value.accepted.join(' / ') : typeof value.text === 'string' ? value.text : '';
    default:
      if (Array.isArray(value.gaps)) {
        return value.gaps.map((g) => (Array.isArray(g) ? g.join(' / ') : String(g ?? ''))).join(' · ');
      }
      return '';
  }
}
