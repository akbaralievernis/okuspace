import { describe, expect, it } from 'vitest';
import { BlockSchema, CourseSchema, GroupSchema, LevelSchema, QuestionSchema, SubmissionGradeSchema, answersFromForm } from '@/server/lms/schemas';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const COURSE = '3a000000-0000-4000-8000-000000000001';
const A = '6a100000-0000-4000-8000-000000000001';
const base = { organizationId: ORG, courseId: COURSE, assessmentId: A, position: '1', skill: 'grammar', prompt: 'Q?', points: '2' };

describe('QuestionSchema builds options and the separate answer key', () => {
  it('single choice: exactly one "*" marks the correct option; option ids are a, b, c…', () => {
    const r = QuestionSchema.parse({ ...base, type: 'single_choice', choices: 'cat\n* dog\nbird' });
    expect(r.options).toEqual([
      { id: 'a', text: 'cat' },
      { id: 'b', text: 'dog' },
      { id: 'c', text: 'bird' },
    ]);
    expect(r.key).toEqual({ option: 'b' });
    expect(JSON.stringify(r.options)).not.toContain('*'); // признак правильности не попадает в варианты
  });

  it('single choice with zero or two correct options is rejected', () => {
    expect(QuestionSchema.safeParse({ ...base, type: 'single_choice', choices: 'a\nb' }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...base, type: 'single_choice', choices: '*a\n*b' }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...base, type: 'single_choice', choices: '*only' }).success).toBe(false);
  });

  it('multiple choice collects every marked option', () => {
    expect(QuestionSchema.parse({ ...base, type: 'multiple_choice', choices: '*a\nb\n*c' }).key).toEqual({ options: ['a', 'c'] });
  });

  it('short text and gap fill accept alternatives separated by "|"', () => {
    expect(QuestionSchema.parse({ ...base, type: 'short_text', accepted: 'went | had gone' }).key).toEqual({ accepted: ['went', 'had gone'] });
    expect(QuestionSchema.parse({ ...base, type: 'gap_fill', accepted: 'is\nare|were' }).key).toEqual({ gaps: [['is'], ['are', 'were']] });
    expect(QuestionSchema.safeParse({ ...base, type: 'short_text', accepted: ' | ' }).success).toBe(false);
  });

  it('points must be positive', () => {
    expect(QuestionSchema.safeParse({ ...base, points: '0', type: 'short_text', accepted: 'x' }).success).toBe(false);
  });
});

describe('BlockSchema', () => {
  const block = { organizationId: ORG, courseId: COURSE, lessonId: A, position: '1' };

  it('parses vocabulary lines "word — meaning" with different dashes', () => {
    const r = BlockSchema.parse({ ...block, type: 'vocabulary', vocabulary: 'hello — привет\nbye - пока\nbroken line' });
    expect(r.content).toEqual({ items: [{ term: 'hello', meaning: 'привет' }, { term: 'bye', meaning: 'пока' }] });
  });

  it('media requires https; text types require a body', () => {
    expect(BlockSchema.safeParse({ ...block, type: 'video', url: 'http://x.example/v.mp4' }).success).toBe(false);
    expect(BlockSchema.parse({ ...block, type: 'audio', url: 'https://x.example/a.mp3', body: 'transcript' }).content).toEqual({ url: 'https://x.example/a.mp3', transcript: 'transcript' });
    expect(BlockSchema.safeParse({ ...block, type: 'text', body: '' }).success).toBe(false);
  });
});

describe('catalog forms', () => {
  it('CEFR levels must use A1…C2 codes', () => {
    const lv = { organizationId: ORG, languageId: A, title: 'x', sortOrder: '1' };
    expect(LevelSchema.safeParse({ ...lv, framework: 'cefr', code: 'A3' }).success).toBe(false);
    expect(LevelSchema.safeParse({ ...lv, framework: 'custom', code: 'Kids-1' }).success).toBe(true);
  });

  it('prices are exact decimals with at most two digits after the point', () => {
    const c = { organizationId: ORG, languageId: A, levelId: A, title: 'Course', format: 'online', kind: 'group', durationWeeks: '12', lessonsPerWeek: '2', status: 'draft' };
    expect(CourseSchema.parse({ ...c, price: '4500.50' }).price).toBe('4500.50');
    expect(CourseSchema.safeParse({ ...c, price: '4500.505' }).success).toBe(false);
    expect(CourseSchema.safeParse({ ...c, price: '-1' }).success).toBe(false);
    expect(CourseSchema.parse({ ...c, price: '' }).price).toBeUndefined();
  });

  it('a group cannot end before it starts', () => {
    const g = { organizationId: ORG, branchId: A, courseId: COURSE, name: 'G', capacity: '10', startsOn: '2026-11-01', enrollmentStatus: 'open' };
    expect(GroupSchema.safeParse({ ...g, endsOn: '2026-10-01' }).success).toBe(false);
    expect(GroupSchema.safeParse({ ...g, endsOn: '' }).success).toBe(true);
  });

  it('grading requires a score; returning for revision does not', () => {
    expect(SubmissionGradeSchema.safeParse({ submissionId: A, decision: 'graded', score: '' }).success).toBe(false);
    expect(SubmissionGradeSchema.safeParse({ submissionId: A, decision: 'returned', score: '' }).success).toBe(true);
  });
});

describe('answersFromForm', () => {
  it('builds the answer object expected by submit_assessment_attempt', () => {
    const form = new FormData();
    form.set('q_1', 'b');
    form.append('q_2', 'a');
    form.append('q_2', 'c');
    form.set('q_3', 'went');
    form.set('q_4_0', 'is');
    form.set('q_4_1', '');
    form.set('q_5', '');
    const out = answersFromForm(form, [
      { id: '1', type: 'single_choice' },
      { id: '2', type: 'multiple_choice' },
      { id: '3', type: 'short_text' },
      { id: '4', type: 'gap_fill', gaps: 2 },
      { id: '5', type: 'short_text' },
    ]);
    expect(out).toEqual({ '1': { option: 'b' }, '2': { options: ['a', 'c'] }, '3': { text: 'went' }, '4': { gaps: ['is', ''] } });
  });
});

describe('gapCount', () => {
  it('counts runs of two or more underscores; at least one gap', async () => {
    const { gapCount } = await import('@/server/lms/schemas');
    expect(gapCount('He __ happy, they ___ tired')).toBe(2);
    expect(gapCount('snake_case is not a gap')).toBe(1);
    expect(gapCount('no gaps')).toBe(1);
  });
});
