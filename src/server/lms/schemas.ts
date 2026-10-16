import { z } from 'zod';

/** Валидация форм каталога и LMS. Права и целостность окончательно проверяет БД. */
const uuid = z.uuid();
const optionalText = (max: number) => z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(max).optional());
const title = z.string().trim().min(1, { message: 'title_required' }).max(200, { message: 'title_required' });

export const LanguageSchema = z.object({
  organizationId: uuid,
  code: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/, { message: 'languages_invalid' }),
  name: z.string().trim().min(2, { message: 'title_required' }).max(100, { message: 'title_required' }),
});

export const LevelSchema = z.object({
  organizationId: uuid,
  languageId: uuid,
  framework: z.enum(['cefr', 'custom']),
  code: z.string().trim().regex(/^[A-Za-z0-9.+-]{1,16}$/, { message: 'level_code_invalid' }),
  title: z.string().trim().min(1, { message: 'title_required' }).max(100, { message: 'title_required' }),
  sortOrder: z.coerce.number().int().min(0).max(1000),
}).refine((v) => v.framework !== 'cefr' || ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(v.code), { message: 'level_code_invalid', path: ['code'] });

export const CourseSchema = z
  .object({
    organizationId: uuid,
    courseId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
    languageId: uuid,
    levelId: uuid,
    title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'title_required' }),
    description: optionalText(5000),
    format: z.enum(['online', 'offline', 'hybrid']),
    kind: z.enum(['group', 'individual']),
    durationWeeks: z.coerce.number().int().min(1, { message: 'duration_invalid' }).max(260, { message: 'duration_invalid' }),
    lessonsPerWeek: z.coerce.number().int().min(1, { message: 'duration_invalid' }).max(14, { message: 'duration_invalid' }),
    price: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, { message: 'price_invalid' }).optional()),
    currency: z.string().regex(/^[A-Z]{3}$/).default('KGS'),
    priceUnit: z.enum(['month', 'course', 'lesson', 'hour']).default('month'),
    status: z.enum(['draft', 'published', 'archived']),
  });

export const GroupSchema = z
  .object({
    organizationId: uuid,
    branchId: uuid,
    courseId: uuid,
    name: z.string().trim().min(1, { message: 'title_required' }).max(100, { message: 'title_required' }),
    capacity: z.coerce.number().int().min(1, { message: 'capacity_invalid' }).max(500, { message: 'capacity_invalid' }),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' }),
    endsOn: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' }).optional()),
    scheduleNote: optionalText(200),
    enrollmentStatus: z.enum(['open', 'closed', 'waitlist']),
  })
  .refine((v) => !v.endsOn || v.endsOn >= v.startsOn, { message: 'date_invalid', path: ['endsOn'], when: () => true });

export const GroupStatusSchema = z.object({ groupId: uuid, status: z.enum(['planned', 'active', 'completed', 'cancelled']), enrollmentStatus: z.enum(['open', 'closed', 'waitlist']) });
export const GroupTeacherSchema = z.object({ organizationId: uuid, branchId: uuid, groupId: uuid, teacherId: uuid });
export const EnrollSchema = z.object({ organizationId: uuid, branchId: uuid, groupId: uuid, studentId: uuid });
export const EnrollmentStatusSchema = z.object({ enrollmentId: uuid, status: z.enum(['pending', 'active', 'paused', 'completed', 'cancelled']) });

// --- Содержание курса ---------------------------------------------------------
export const ModuleSchema = z.object({
  organizationId: uuid,
  courseId: uuid,
  moduleId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
  title,
  position: z.coerce.number().int().min(0).max(10000),
  status: z.enum(['draft', 'published']),
});

export const LessonSchema = z.object({
  organizationId: uuid,
  courseId: uuid,
  moduleId: uuid,
  lessonId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
  title,
  position: z.coerce.number().int().min(0).max(10000),
  estimatedMinutes: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(600).optional()),
  status: z.enum(['draft', 'published']),
});

export const BLOCK_TYPES = ['text', 'reading', 'writing_prompt', 'speaking_prompt', 'vocabulary', 'video', 'audio', 'listening'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * Блок урока из формы: текстовые типы — body; медиа — https-ссылка (+ необязательная расшифровка);
 * словарь — строки «слово — значение».
 */
export const BlockSchema = z
  .object({
    organizationId: uuid,
    courseId: uuid,
    lessonId: uuid,
    position: z.coerce.number().int().min(0).max(10000),
    type: z.enum(BLOCK_TYPES),
    body: optionalText(50000),
    url: optionalText(2000),
    vocabulary: optionalText(20000),
  })
  .transform((v, ctx) => {
    let content: Record<string, unknown>;
    if (['text', 'reading', 'writing_prompt', 'speaking_prompt'].includes(v.type)) {
      if (!v.body) ctx.addIssue({ code: 'custom', message: 'body_required', path: ['body'] });
      content = { body: v.body ?? '' };
    } else if (v.type === 'vocabulary') {
      const items = (v.vocabulary ?? '')
        .split('\n')
        .map((line) => line.split(/\s+[—–-]\s+/))
        .filter((parts) => parts.length >= 2 && parts[0]!.trim() && parts[1]!.trim())
        .map(([term, ...rest]) => ({ term: term!.trim(), meaning: rest.join(' — ').trim() }));
      if (items.length === 0) ctx.addIssue({ code: 'custom', message: 'vocabulary_invalid', path: ['vocabulary'] });
      content = { items };
    } else {
      if (!v.url || !/^https:\/\/\S+$/.test(v.url)) ctx.addIssue({ code: 'custom', message: 'url_invalid', path: ['url'] });
      content = { url: v.url ?? '', ...(v.body ? { transcript: v.body } : {}) };
    }
    return { organizationId: v.organizationId, courseId: v.courseId, lessonId: v.lessonId, position: v.position, type: v.type, content };
  });

export const AssessmentSchema = z.object({
  organizationId: uuid,
  courseId: uuid,
  assessmentId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
  lessonId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
  title,
  instructions: optionalText(5000),
  maxAttempts: z.coerce.number().int().min(1).max(20),
  revealAnswers: z.enum(['never', 'after_submit', 'after_due']),
  status: z.enum(['draft', 'published', 'archived']),
});

export const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'short_text', 'gap_fill'] as const;

/**
 * Вопрос из формы. Варианты — строки «* текст» (звёздочка — правильный вариант);
 * текстовый ответ — допустимые ответы через «|»; пропуски — по строке на пропуск, варианты через «|».
 */
export const QuestionSchema = z
  .object({
    organizationId: uuid,
    courseId: uuid,
    assessmentId: uuid,
    position: z.coerce.number().int().min(0).max(1000),
    type: z.enum(QUESTION_TYPES),
    skill: z.enum(['grammar', 'vocabulary', 'reading', 'listening']),
    prompt: z.string().trim().min(1, { message: 'body_required' }).max(5000),
    points: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, { message: 'points_invalid' }).refine((p) => Number(p) > 0, { message: 'points_invalid' }),
    choices: optionalText(5000),
    accepted: optionalText(5000),
    explanation: optionalText(5000),
  })
  .transform((v, ctx) => {
    let options: { id: string; text: string }[] = [];
    let key: Record<string, unknown> = {};
    if (v.type === 'single_choice' || v.type === 'multiple_choice') {
      const lines = (v.choices ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      options = lines.map((line, i) => ({ id: String.fromCharCode(97 + i), text: line.replace(/^\*\s*/, '') }));
      const correct = lines.flatMap((line, i) => (line.startsWith('*') ? [String.fromCharCode(97 + i)] : []));
      if (options.length < 2 || options.length > 10) ctx.addIssue({ code: 'custom', message: 'choices_invalid', path: ['choices'] });
      if (correct.length === 0 || (v.type === 'single_choice' && correct.length !== 1)) {
        ctx.addIssue({ code: 'custom', message: 'correct_invalid', path: ['choices'] });
      }
      key = v.type === 'single_choice' ? { option: correct[0] ?? '' } : { options: correct };
    } else if (v.type === 'short_text') {
      const accepted = (v.accepted ?? '').split('|').map((a) => a.trim()).filter(Boolean);
      if (accepted.length === 0) ctx.addIssue({ code: 'custom', message: 'accepted_invalid', path: ['accepted'] });
      key = { accepted };
    } else {
      const gaps = (v.accepted ?? '').split('\n').map((line) => line.split('|').map((a) => a.trim()).filter(Boolean)).filter((g) => g.length);
      if (gaps.length === 0) ctx.addIssue({ code: 'custom', message: 'accepted_invalid', path: ['accepted'] });
      key = { gaps };
    }
    return { ...v, options, key };
  });

export const GroupAssessmentSchema = z
  .object({
    organizationId: uuid,
    branchId: uuid,
    groupId: uuid,
    assessmentId: uuid,
    opensAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'start_invalid' }),
    dueAt: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'start_invalid' }).optional()),
  });

export const RetakeSchema = z.object({
  organizationId: uuid,
  assessmentId: uuid,
  studentId: uuid,
  reason: optionalText(500),
});

export const SubmissionGradeSchema = z
  .object({
    submissionId: uuid,
    decision: z.enum(['graded', 'returned']),
    score: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, { message: 'points_invalid' }).optional()),
    feedback: optionalText(20000),
  })
  .refine((v) => v.decision === 'returned' || v.score !== undefined, { message: 'points_invalid', path: ['score'], when: () => true });

export const HomeworkSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  groupId: uuid,
  title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'title_required' }),
  instructions: optionalText(20000),
  dueAt: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'start_invalid' }).optional()),
  maxScore: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, { message: 'points_invalid' }),
});

export const SubmissionSchema = z.object({
  assignmentId: uuid,
  organizationId: uuid,
  branchId: uuid,
  body: z.string().trim().min(1, { message: 'body_required' }).max(50000, { message: 'body_required' }),
});

/** Число пропусков в вопросе типа gap_fill: каждое «__» (два и более подчёркивания) — пропуск. */
export function gapCount(prompt: string): number {
  return Math.max(1, (prompt.match(/_{2,}/g) ?? []).length);
}

/** Ответы ученика из формы теста → объект для submit_assessment_attempt. */
export function answersFromForm(form: FormData, questions: { id: string; type: (typeof QUESTION_TYPES)[number]; gaps?: number }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    const name = `q_${q.id}`;
    if (q.type === 'single_choice') {
      const v = form.get(name);
      if (typeof v === 'string' && v) out[q.id] = { option: v };
    } else if (q.type === 'multiple_choice') {
      const vs = form.getAll(name).filter((x): x is string => typeof x === 'string');
      if (vs.length) out[q.id] = { options: vs };
    } else if (q.type === 'short_text') {
      const v = form.get(name);
      if (typeof v === 'string' && v.trim()) out[q.id] = { text: v.slice(0, 500) };
    } else {
      const gaps = Array.from({ length: q.gaps ?? 0 }, (_, i) => {
        const v = form.get(`${name}_${i}`);
        return typeof v === 'string' ? v.slice(0, 200) : '';
      });
      if (gaps.some(Boolean)) out[q.id] = { gaps };
    }
  }
  return out;
}
