'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { logger } from '@/lib/logger';
import { zonedLocalToUtc } from '@/lib/time';
import { dbState, localeOf, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';
import {
  AssessmentSchema,
  BlockSchema,
  CourseSchema,
  EnrollSchema,
  EnrollmentStatusSchema,
  GroupAssessmentSchema,
  GroupSchema,
  GroupStatusSchema,
  GroupTeacherSchema,
  HomeworkSchema,
  LanguageSchema,
  LessonSchema,
  LevelSchema,
  ModuleSchema,
  QuestionSchema,
  RetakeSchema,
  SubmissionGradeSchema,
  SubmissionSchema,
  answersFromForm,
  gapCount,
} from './schemas';

/*
 * Действия каталога и LMS. Все запросы — от имени пользователя (RLS). Руководство
 * (каталог, группы, записи) — с MFA; преподаватели и ученики — без требования MFA.
 */
const STAFF = { mfa: true };
const PERSON = { mfa: false };
const idOf = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
};

// --- Каталог ------------------------------------------------------------------
export async function saveLanguageAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/catalog'], async () => {
    const r = parseForm(LanguageSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.from('languages').insert({ organization_id: r.data.organizationId, code: r.data.code, name: r.data.name });
    return dbState(error);
  }, STAFF);
}

export async function saveLevelAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/catalog'], async () => {
    const r = parseForm(LevelSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('course_levels').insert({
      organization_id: v.organizationId, language_id: v.languageId, framework: v.framework, code: v.code, title: v.title, sort_order: v.sortOrder,
    });
    return dbState(error);
  }, STAFF);
}

export async function saveCourseAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/catalog', '/courses', '/prices'], async () => {
    const r = parseForm(CourseSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const row = {
      organization_id: v.organizationId, language_id: v.languageId, level_id: v.levelId, title: v.title, description: v.description ?? null,
      format: v.format, kind: v.kind, duration_weeks: v.durationWeeks, lessons_per_week: v.lessonsPerWeek, status: v.status,
      public_price: v.price ?? null, public_price_currency: v.price ? v.currency : null, public_price_unit: v.price ? v.priceUnit : null,
    };
    const db = await createUserClient();
    if (v.courseId) {
      const { data, error } = await db.from('courses').update(row).eq('id', v.courseId).select('id');
      return dbState(error, data);
    }
    const { error } = await db.from('courses').insert(row);
    return dbState(error);
  }, STAFF);
}

// --- Группы и записи --------------------------------------------------------------
export async function createGroupAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups', '/courses'], async () => {
    const r = parseForm(GroupSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('groups').insert({
      organization_id: v.organizationId, branch_id: v.branchId, course_id: v.courseId, name: v.name, capacity: v.capacity,
      starts_on: v.startsOn, ends_on: v.endsOn ?? null, schedule_note: v.scheduleNote ?? null, enrollment_status: v.enrollmentStatus,
    });
    return dbState(error);
  }, STAFF);
}

export async function setGroupStatusAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups', '/courses'], async () => {
    const r = parseForm(GroupStatusSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('groups').update({ status: r.data.status, enrollment_status: r.data.enrollmentStatus }).eq('id', r.data.groupId).select('id');
    return dbState(error, data);
  }, STAFF);
}

export async function assignTeacherAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups'], async () => {
    const r = parseForm(GroupTeacherSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('group_teachers').insert({ organization_id: v.organizationId, branch_id: v.branchId, group_id: v.groupId, teacher_id: v.teacherId });
    return dbState(error);
  }, STAFF);
}

export async function enrollStudentAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups', '/courses'], async (userId) => {
    const r = parseForm(EnrollSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('enrollments').insert({
      organization_id: v.organizationId, branch_id: v.branchId, group_id: v.groupId, student_id: v.studentId, status: 'active', created_by: userId,
    });
    if (error?.message?.includes('group is full')) return { status: 'error', code: 'slot_full' };
    return dbState(error);
  }, STAFF);
}

export async function setEnrollmentStatusAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups'], async () => {
    const r = parseForm(EnrollmentStatusSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('enrollments').update({ status: r.data.status }).eq('id', r.data.enrollmentId).select('id');
    if (error?.message?.includes('group is full')) return { status: 'error', code: 'slot_full' };
    return dbState(error, data);
  }, STAFF);
}

// --- Содержание курса (преподаватели курса и методисты) ------------------------------
export async function saveModuleAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses'], async () => {
    const r = parseForm(ModuleSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const row = { organization_id: v.organizationId, course_id: v.courseId, title: v.title, position: v.position, status: v.status };
    if (v.moduleId) {
      const { data, error } = await db.from('course_modules').update({ title: v.title, position: v.position, status: v.status }).eq('id', v.moduleId).select('id');
      return dbState(error, data);
    }
    const { error } = await db.from('course_modules').insert(row);
    return dbState(error);
  }, PERSON);
}

export async function saveLessonAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses', '/app/learn'], async () => {
    const r = parseForm(LessonSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const fields = { title: v.title, position: v.position, estimated_minutes: v.estimatedMinutes ?? null, status: v.status };
    if (v.lessonId) {
      const { data, error } = await db.from('lessons').update(fields).eq('id', v.lessonId).select('id');
      return dbState(error, data);
    }
    const { error } = await db.from('lessons').insert({ organization_id: v.organizationId, course_id: v.courseId, module_id: v.moduleId, ...fields });
    return dbState(error);
  }, PERSON);
}

export async function addBlockAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses', '/app/learn'], async () => {
    const r = parseForm(BlockSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('lesson_blocks').insert({
      organization_id: v.organizationId, course_id: v.courseId, lesson_id: v.lessonId, position: v.position, type: v.type, content: v.content,
    });
    return dbState(error);
  }, PERSON);
}

export async function deleteBlockAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses', '/app/learn'], async () => {
    const id = idOf(form, 'blockId');
    if (!id) return { status: 'error', code: 'validation' };
    const db = await createUserClient();
    const { data, error } = await db.from('lesson_blocks').delete().eq('id', id).select('id');
    return dbState(error, data);
  }, PERSON);
}

// --- Тесты ---------------------------------------------------------------------
export async function saveAssessmentAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses'], async (userId) => {
    const r = parseForm(AssessmentSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const fields = { title: v.title, instructions: v.instructions ?? null, max_attempts: v.maxAttempts, reveal_answers: v.revealAnswers, status: v.status, lesson_id: v.lessonId ?? null };
    if (v.assessmentId) {
      const { data, error } = await db.from('assessments').update(fields).eq('id', v.assessmentId).select('id');
      return dbState(error, data);
    }
    const { error } = await db.from('assessments').insert({ organization_id: v.organizationId, course_id: v.courseId, created_by: userId, ...fields });
    return dbState(error);
  }, PERSON);
}

export async function addQuestionAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses'], async () => {
    const r = parseForm(QuestionSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data, error } = await db
      .from('assessment_questions')
      .insert({
        organization_id: v.organizationId, course_id: v.courseId, assessment_id: v.assessmentId, position: v.position, type: v.type,
        skill: v.skill, prompt: v.prompt, options: v.options, points: v.points, explanation: v.explanation ?? null,
      })
      .select('id')
      .single();
    if (error || !data) return dbState(error, []);
    // Ключ — отдельной записью; если не сохранился, вопрос удаляется, чтобы не остался без ключа.
    const keyResult = await db.from('assessment_answer_keys').insert({ question_id: data.id, organization_id: v.organizationId, key: v.key });
    if (keyResult.error) {
      await db.from('assessment_questions').delete().eq('id', data.id);
      return dbState(keyResult.error);
    }
    return { status: 'success', code: 'saved' };
  }, PERSON);
}

export async function deleteQuestionAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/courses'], async () => {
    const id = idOf(form, 'questionId');
    if (!id) return { status: 'error', code: 'validation' };
    const db = await createUserClient();
    const { data, error } = await db.from('assessment_questions').delete().eq('id', id).select('id');
    if (error?.message?.includes('already has submitted answers')) return { status: 'error', code: 'forbidden' };
    return dbState(error, data);
  }, PERSON);
}

// --- Работа с группой (преподаватель) ------------------------------------------------
export async function assignAssessmentAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups', '/app/learn'], async (userId) => {
    const r = parseForm(GroupAssessmentSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data: branch } = await db.from('branches').select('timezone').eq('id', v.branchId).maybeSingle();
    const tz = (branch?.timezone as string | undefined) ?? 'Asia/Bishkek';
    const opens = zonedLocalToUtc(v.opensAt, tz);
    const due = v.dueAt ? zonedLocalToUtc(v.dueAt, tz) : null;
    if (!opens || (v.dueAt && !due)) return { status: 'error', code: 'validation', fieldErrors: { opensAt: ['start_invalid'] } };
    if (due && due <= opens) return { status: 'error', code: 'validation', fieldErrors: { dueAt: ['date_invalid'] } };
    const { error } = await db.from('group_assessments').upsert(
      { organization_id: v.organizationId, branch_id: v.branchId, group_id: v.groupId, assessment_id: v.assessmentId, opens_at: opens.toISOString(), due_at: due?.toISOString() ?? null, assigned_by: userId },
      { onConflict: 'group_id,assessment_id' },
    );
    return dbState(error);
  }, PERSON);
}

export async function grantRetakeAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups'], async (userId) => {
    const r = parseForm(RetakeSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('assessment_retakes').insert({
      organization_id: v.organizationId, assessment_id: v.assessmentId, student_id: v.studentId, extra_attempts: 1, reason: v.reason ?? null, granted_by: userId,
    });
    return dbState(error);
  }, PERSON);
}

export async function createHomeworkAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups', '/app/learn'], async () => {
    const r = parseForm(HomeworkSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data: branch } = await db.from('branches').select('timezone').eq('id', v.branchId).maybeSingle();
    const due = v.dueAt ? zonedLocalToUtc(v.dueAt, (branch?.timezone as string | undefined) ?? 'Asia/Bishkek') : null;
    // Флажки `student` — задание только выбранным ученикам; без флажков — всей группе.
    const students = form.getAll('student').map(String);
    if (!students.every((s) => /^[0-9a-f-]{36}$/i.test(s))) return { status: 'error', code: 'validation' };
    const { error } = await db.rpc('assignment_create', {
      p_group: v.groupId, p_title: v.title, p_instructions: v.instructions ?? null, p_due_at: due?.toISOString() ?? null,
      p_max_score: v.maxScore, p_students: [...new Set(students)],
    });
    return dbState(error);
  }, PERSON);
}

export async function gradeSubmissionAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/groups', '/app/learn'], async () => {
    const r = parseForm(SubmissionGradeSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data, error } = await db
      .from('assignment_submissions')
      .update({ status: v.decision, score: v.decision === 'graded' ? v.score : null, feedback: v.feedback ?? null })
      .eq('id', v.submissionId)
      .select('id');
    if (error?.message?.includes('exceeds max_score')) return { status: 'error', code: 'validation', fieldErrors: { score: ['points_invalid'] } };
    return dbState(error, data);
  }, PERSON);
}

// --- Ученик ------------------------------------------------------------------------
export async function submitHomeworkAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/learn'], async (userId) => {
    const r = parseForm(SubmissionSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    // Повторная отправка обновляет ту же работу (уникальность «задание + ученик» в БД).
    const { data: existing } = await db.from('assignment_submissions').select('id').eq('assignment_id', v.assignmentId).eq('student_id', userId).maybeSingle();
    if (existing) {
      const { data, error } = await db.from('assignment_submissions').update({ body: v.body }).eq('id', existing.id).select('id');
      if (error?.message?.includes('graded work cannot be changed')) return { status: 'error', code: 'forbidden' };
      return dbState(error, data);
    }
    const { error } = await db.from('assignment_submissions').insert({
      organization_id: v.organizationId, branch_id: v.branchId, assignment_id: v.assignmentId, student_id: userId, body: v.body,
    });
    if (error?.message?.includes('not available')) return { status: 'error', code: 'forbidden' };
    return dbState(error);
  }, PERSON);
}

export async function trackLessonAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/learn'], async () => {
    const id = idOf(form, 'lessonId');
    if (!id) return { status: 'error', code: 'validation' };
    const db = await createUserClient();
    const { error } = await db.rpc('track_lesson', { p_lesson: id, p_completed: form.get('completed') === 'true' });
    return dbState(error);
  }, PERSON);
}

/**
 * Отправка теста. Ключ идемпотентности выдаётся при открытии формы (скрытое поле): повторная
 * отправка той же формы возвращает ту же попытку. Проверка — функцией БД.
 */
export async function submitAttemptAction(_p: FormState, form: FormData): Promise<FormState> {
  let attemptId: string | null = null;
  const state = await runAction(form, ['/app/learn'], async () => {
    const assessmentId = idOf(form, 'assessmentId');
    const key = idOf(form, 'idempotencyKey');
    if (!assessmentId || !key) return { status: 'error', code: 'validation' };
    const db = await createUserClient();
    const { data: questions, error: qError } = await db.from('assessment_questions').select('id, type, options, prompt').eq('assessment_id', assessmentId);
    if (qError) return dbState(qError);
    const answers = answersFromForm(
      form,
      (questions ?? []).map((q) => ({
        id: q.id as string,
        type: q.type as 'single_choice' | 'multiple_choice' | 'short_text' | 'gap_fill',
        gaps: q.type === 'gap_fill' ? gapCount(q.prompt as string) : 0,
      })),
    );
    const { data, error } = await db.rpc('submit_assessment_attempt', { p_assessment: assessmentId, p_answers: answers, p_idempotency_key: key });
    if (error?.message?.includes('no attempts left')) return { status: 'error', code: 'no_attempts_left' };
    if (error?.message?.includes('not available')) return { status: 'error', code: 'forbidden' };
    if (error) return dbState(error);
    attemptId = data as string;
    return { status: 'success', code: 'saved' };
  }, PERSON);
  if (attemptId) redirect(`/${localeOf(form)}/app/learn/attempts/${attemptId}`);
  return state;
}

/** Новый ключ идемпотентности для формы теста (генерируется на сервере). */
export async function newAttemptKey(): Promise<string> {
  return randomUUID();
}

/**
 * Отметка «урок открыт» (без завершения). Вызывается со страницы урока после монтирования:
 * запись при GET-рендере сработала бы и на prefetch. Кэш не сбрасывается — меняется только «последний урок».
 */
export async function recordLessonVisit(lessonId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(lessonId)) return;
  try {
    const db = await createUserClient();
    const { error } = await db.rpc('track_lesson', { p_lesson: lessonId, p_completed: false });
    if (error && error.code !== '42501') logger.error('track_lesson failed', { code: error.code });
  } catch (error) {
    logger.error('track_lesson failed', { error });
  }
}
