'use server';

import { z } from 'zod';
import { DEFAULT_TIMEZONE, zonedLocalToUtc } from '@/lib/time';
import { dbState, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';
import { AUDIENCE_ROLES, PRIORITIES } from './constants';

/**
 * Задачи и объявления. Права и переходы проверяет БД (функции task_* / announcement_*);
 * здесь — разбор формы и понятные ошибки. Руководителям нужен MFA, исполнителям — нет.
 */
const MANAGER = { mfa: true };
const PERSON = { mfa: false };
const TASK_PATHS = ['/app/tasks', '/app/dashboard', '/app'];
const ANN_PATHS = ['/app/announcements', '/app/dashboard', '/app'];
const uuid = z.uuid();
const blank = (v: unknown) => (v === '' ? undefined : v);
const text = (max: number, code: 'message_too_long' = 'message_too_long') => z.preprocess(blank, z.string().trim().max(max, { message: code }).optional());

/** Ошибки функций БД → поля формы. */
function taskError(error: { code?: string; message?: string } | null): FormState | null {
  if (!error) return null;
  const m = error.message ?? '';
  if (/report required/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { note: ['body_required'] } };
  if (/comment required|reason required|comment length/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { note: ['reason_required'] } };
  if (/due date/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { dueDate: ['start_past'] } };
  if (/assignee is not staff/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { targets: ['assignees_required'] } };
  if (/no recipients/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { audience: ['audience_required'] } };
  return null;
}

const CreateTask = z.object({
  organizationId: uuid,
  title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'message_too_long' }),
  description: text(5000),
  priority: z.enum(PRIORITIES),
  dueDate: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' }).optional()),
  dueTime: z.preprocess(blank, z.string().regex(/^\d{2}:\d{2}$/, { message: 'time_invalid' }).optional()),
});

/** Исполнители — флажки `target` со значением `<profileId>|<branchId или пусто>`. */
function targetsOf(form: FormData): { profileId: string; branchId: string | null }[] | null {
  const out: { profileId: string; branchId: string | null }[] = [];
  for (const raw of form.getAll('target')) {
    const [profileId, branchId] = String(raw).split('|');
    if (!uuid.safeParse(profileId).success || (branchId && !uuid.safeParse(branchId).success)) return null;
    out.push({ profileId: profileId!, branchId: branchId || null });
  }
  return out.length >= 1 && out.length <= 50 ? out : null;
}

export async function createTaskAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, TASK_PATHS, async () => {
    const r = parseForm(CreateTask, form);
    if (!r.ok) return r.state;
    const targets = targetsOf(form);
    if (!targets) return { status: 'error', code: 'validation', fieldErrors: { targets: ['assignees_required'] } };
    const v = r.data;
    const db = await createUserClient();
    let dueAt: string | null = null;
    if (v.dueDate) {
      const { data: org } = await db.from('organizations').select('default_timezone').eq('id', v.organizationId).maybeSingle();
      const due = zonedLocalToUtc(`${v.dueDate}T${v.dueTime ?? '18:00'}`, (org?.default_timezone as string) ?? DEFAULT_TIMEZONE);
      if (!due) return { status: 'error', code: 'validation', fieldErrors: { dueDate: ['date_invalid'] } };
      dueAt = due.toISOString();
    }
    const { error } = await db.rpc('task_create', {
      p_org: v.organizationId,
      p_targets: targets,
      p_title: v.title,
      p_description: v.description ?? null,
      p_priority: v.priority,
      p_due_at: dueAt,
    });
    return taskError(error) ?? dbState(error);
  }, MANAGER);
}

const Transition = z.object({ taskId: uuid, note: text(5000) });

/** Исполнитель: взять в работу / сдать отчёт. */
export async function taskWorkAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, TASK_PATHS, async () => {
    const r = parseForm(Transition.extend({ action: z.enum(['start', 'submit']) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('task_transition', { p_task: r.data.taskId, p_action: r.data.action, p_note: r.data.note ?? null });
    return taskError(error) ?? dbState(error);
  }, PERSON);
}

/** Руководитель: принять / вернуть / отменить. */
export async function taskReviewAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, TASK_PATHS, async () => {
    const r = parseForm(Transition.extend({ action: z.enum(['accept', 'return', 'cancel']) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('task_transition', { p_task: r.data.taskId, p_action: r.data.action, p_note: r.data.note ?? null });
    return taskError(error) ?? dbState(error);
  }, MANAGER);
}

export async function taskCommentAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, TASK_PATHS, async () => {
    const r = parseForm(z.object({ taskId: uuid, note: z.string().trim().min(1, { message: 'body_required' }).max(2000, { message: 'message_too_long' }) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('task_comment', { p_task: r.data.taskId, p_body: r.data.note });
    return taskError(error) ?? dbState(error);
  }, PERSON);
}

const Publish = z.object({
  organizationId: uuid,
  branchId: z.preprocess(blank, uuid.optional()),
  title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'message_too_long' }),
  body: z.string().trim().min(1, { message: 'body_required' }).max(10000, { message: 'message_too_long' }),
});

export async function publishAnnouncementAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ANN_PATHS, async () => {
    const r = parseForm(Publish, form);
    if (!r.ok) return r.state;
    const audience = form.getAll('audience').map(String);
    if (audience.length === 0 || !audience.every((a) => (AUDIENCE_ROLES as readonly string[]).includes(a))) {
      return { status: 'error', code: 'validation', fieldErrors: { audience: ['audience_required'] } };
    }
    const db = await createUserClient();
    const { error } = await db.rpc('announcement_publish', {
      p_org: r.data.organizationId,
      p_branch: r.data.branchId ?? null,
      p_title: r.data.title,
      p_body: r.data.body,
      p_audience: [...new Set(audience)],
      p_requires_ack: form.get('requiresAck') === 'on',
    });
    return taskError(error) ?? dbState(error);
  }, MANAGER);
}

export async function acknowledgeAnnouncementAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ANN_PATHS, async () => {
    const r = parseForm(z.object({ announcementId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('announcement_read', { p_id: r.data.announcementId, p_ack: true });
    return dbState(error);
  }, PERSON);
}

export async function archiveAnnouncementAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ANN_PATHS, async () => {
    const r = parseForm(z.object({ announcementId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('announcement_archive', { p_id: r.data.announcementId });
    return dbState(error);
  }, MANAGER);
}
