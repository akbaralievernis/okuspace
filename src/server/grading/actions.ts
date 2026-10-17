'use server';

import { z } from 'zod';
import { dbState, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';

/**
 * Экзамены, итоги месяца, правила оценивания. Права проверяет БД: преподаватель группы
 * (или руководство с group.manage) — экзамены и итоги; директор с MFA — правила школы.
 */
const TEACHER = { mfa: false };
const DIRECTOR = { mfa: true };
const PATHS = ['/app/groups', '/app/learn'];
const uuid = z.uuid();
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const score = z.string().trim().regex(/^\d{1,4}([.,]\d{1,2})?$/, { message: 'points_invalid' }).transform((v) => v.replace(',', '.'));

function examError(error: { code?: string; message?: string } | null): FormState | null {
  if (!error) return null;
  if (/exceeds max_score/.test(error.message ?? '')) return { status: 'error', code: 'validation', fieldErrors: { score: ['points_invalid'] } };
  if (/invalid month/.test(error.message ?? '')) return { status: 'error', code: 'validation', fieldErrors: { month: ['month_invalid'] } };
  return null;
}

const CreateExam = z.object({
  organizationId: uuid,
  branchId: uuid,
  groupId: uuid,
  title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'message_too_long' }),
  heldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' }),
  maxScore: score,
});

export async function createExamAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(CreateExam, form);
    if (!r.ok) return r.state;
    const v = r.data;
    if (Number(v.maxScore) <= 0) return { status: 'error', code: 'validation', fieldErrors: { maxScore: ['points_invalid'] } };
    const db = await createUserClient();
    const { error } = await db.from('group_exams').insert({
      organization_id: v.organizationId, branch_id: v.branchId, group_id: v.groupId, title: v.title, held_on: v.heldOn, max_score: v.maxScore, created_by: userId,
    });
    return examError(error) ?? dbState(error);
  }, TEACHER);
}

/** Поля `score:<ученик>` и `absent:<ученик>`; пустой балл без отметки «не пришёл» — пропускаем. */
export async function saveExamResultsAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ examId: uuid, organizationId: uuid }).loose(), form);
    if (!r.ok) return r.state;
    const students = new Set<string>();
    for (const key of form.keys()) {
      const m = /^(score|absent):([0-9a-f-]{36})$/i.exec(key);
      if (m) students.add(m[2]!);
    }
    const rowsToSave: { exam_id: string; student_id: string; organization_id: string; score: string | null; absent: boolean }[] = [];
    for (const sid of students) {
      const raw = String(form.get(`score:${sid}`) ?? '').trim();
      const absent = form.get(`absent:${sid}`) === 'on';
      if (!raw && !absent) continue;
      if (absent) {
        rowsToSave.push({ exam_id: r.data.examId, student_id: sid, organization_id: r.data.organizationId, score: null, absent: true });
        continue;
      }
      const parsed = score.safeParse(raw);
      if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: { score: ['points_invalid'] } };
      rowsToSave.push({ exam_id: r.data.examId, student_id: sid, organization_id: r.data.organizationId, score: parsed.data, absent: false });
    }
    if (rowsToSave.length === 0) return { status: 'success', code: 'saved' };
    const db = await createUserClient();
    const { error } = await db.from('exam_results').upsert(rowsToSave, { onConflict: 'exam_id,student_id' });
    return examError(error) ?? dbState(error);
  }, TEACHER);
}

export async function publishExamAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ examId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('group_exams').update({ status: 'published' }).eq('id', r.data.examId).eq('status', 'draft').select('id');
    return dbState(error, data);
  }, TEACHER);
}

export async function setTestAsExamAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ groupId: uuid, assessmentId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('group_assessments')
      .update({ counts_as_exam: form.get('countsAsExam') === 'on' })
      .eq('group_id', r.data.groupId)
      .eq('assessment_id', r.data.assessmentId)
      .select('group_id');
    return dbState(error, data);
  }, TEACHER);
}

const MonthForm = z.object({ groupId: uuid, month: z.string().regex(MONTH, { message: 'month_invalid' }) });

export async function recomputeReportsAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async () => {
    const r = parseForm(MonthForm, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('report_cards_generate', { p_group: r.data.groupId, p_month: `${r.data.month}-01` });
    return examError(error) ?? dbState(error);
  }, TEACHER);
}

export async function publishReportsAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async () => {
    const r = parseForm(MonthForm, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('report_cards_publish', { p_group: r.data.groupId, p_month: `${r.data.month}-01` });
    return dbState(error);
  }, TEACHER);
}

export async function reportCommentAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ reportId: uuid, comment: z.string().max(2000, { message: 'message_too_long' }) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('report_card_comment', { p_id: r.data.reportId, p_comment: r.data.comment });
    return dbState(error);
  }, TEACHER);
}

const weight = z.coerce.number({ message: 'weights_invalid' }).int({ message: 'weights_invalid' }).min(0, { message: 'weights_invalid' }).max(100, { message: 'weights_invalid' });
const Policy = z
  .object({ organizationId: uuid, attendance: weight, homework: weight, tests: weight, exam: weight, scale: z.enum(['five', 'percent']) })
  .refine((v) => v.attendance + v.homework + v.tests + v.exam === 100, { message: 'weights_invalid', path: ['attendance'], when: () => true });

export async function saveGradingPolicyAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/grading', '/app/groups'], async (userId) => {
    const r = parseForm(Policy, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const values = { weight_attendance: v.attendance, weight_homework: v.homework, weight_tests: v.tests, weight_exam: v.exam, scale: v.scale, updated_by: userId };
    const { data: existing } = await db.from('grading_policies').select('organization_id').eq('organization_id', v.organizationId).maybeSingle();
    if (existing) {
      const { data, error } = await db.from('grading_policies').update(values).eq('organization_id', v.organizationId).select('organization_id');
      return dbState(error, data);
    }
    const { error } = await db.from('grading_policies').insert({ organization_id: v.organizationId, ...values });
    return dbState(error);
  }, DIRECTOR);
}
