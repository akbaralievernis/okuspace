'use server';

import type { PostgrestError } from '@supabase/supabase-js';
import { getDictionary } from '@/i18n/get-dictionary';
import { fieldErrors } from '@/lib/auth/schemas';
import { DEFAULT_TIMEZONE, zonedLocalToUtc } from '@/lib/time';
import { dbState, formObject, localeOf, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import {
  CancelSchema,
  CheckInSchema,
  ClassroomSchema,
  ClassroomStatusSchema,
  RescheduleSchema,
  SeriesSchema,
  marksFromForm,
} from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

/** Изменения расписания — действия сотрудников (MFA); отметки и коды — преподаватель и ученик. */
const STAFF = { mfa: true };
const PERSON = { mfa: false };
const PATHS = ['/app/schedule', '/app/notifications'];

const idOf = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
};

const timeIn = (locale: string, iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale === 'ky' ? 'ky-KG' : locale === 'en' ? 'en-GB' : 'ru-RU', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

/** Конфликт EXCLUDE → понятное сообщение: кто занят и когда (без деталей чужих групп). */
function conflictState(form: FormData, error: PostgrestError, date?: string): FormState {
  const t = getDictionary(localeOf(form)).schedule;
  const what = error.message.includes('teacher_excl') ? t.conflictTeacher : error.message.includes('classroom_excl') ? t.conflictRoom : t.conflictGeneric;
  return { status: 'error', code: 'schedule_conflict', data: { what, date: date ?? '' } };
}

export async function saveClassroomAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(ClassroomSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.from('classrooms').insert({
      organization_id: r.data.organizationId, branch_id: r.data.branchId, name: r.data.name, capacity: r.data.capacity,
    });
    return dbState(error);
  }, STAFF);
}

export async function setClassroomStatusAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(ClassroomStatusSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('classrooms').update({ status: r.data.status }).eq('id', r.data.classroomId).select('id');
    return dbState(error, data);
  }, STAFF);
}

export async function createSeriesAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    // Дни недели — несколько чекбоксов с одним именем.
    const parsed = SeriesSchema.safeParse({ ...formObject(form), weekdays: form.getAll('weekdays') });
    if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
    const v = parsed.data;
    const db = await createUserClient();
    const { data, error } = await db.rpc('create_session_series', {
      p_group: v.groupId, p_teacher: v.teacherId, p_classroom: v.classroomId ?? null, p_online_url: v.onlineUrl ?? null,
      p_first_date: v.firstDate, p_weekdays: v.weekdays, p_start: v.startTime, p_minutes: v.minutes, p_count: v.count, p_topic: v.topic ?? null,
    });
    if (error?.code === '23P01') return conflictState(form, error, /conflict on (\d{4}-\d{2}-\d{2})/.exec(error.message)?.[1]);
    if (error?.message?.includes('not assigned to this group')) return { status: 'error', code: 'validation', fieldErrors: { teacherId: ['role_invalid'] } };
    if (error?.message?.includes('lesson_sessions_place_check')) return { status: 'error', code: 'validation', fieldErrors: { classroomId: ['place_required'] } };
    if (error) return dbState(error);
    return { status: 'success', code: 'sessions_created', data: { count: String((data as unknown[] | null)?.length ?? 0) } };
  }, STAFF);
}

async function sessionZone(sessionId: string): Promise<string | null> {
  const db = await createUserClient();
  const { data } = await db.from('lesson_sessions').select('groups(branches(timezone))').eq('id', sessionId).maybeSingle();
  if (!data) return null;
  const g = (data as { groups: unknown }).groups;
  const group = (Array.isArray(g) ? g[0] : g) as { branches: { timezone: string } | { timezone: string }[] } | undefined;
  const b = Array.isArray(group?.branches) ? group?.branches[0] : group?.branches;
  return b?.timezone ?? DEFAULT_TIMEZONE;
}

export async function rescheduleAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(RescheduleSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const tz = await sessionZone(v.sessionId);
    if (!tz) return { status: 'error', code: 'forbidden' };
    const start = zonedLocalToUtc(`${v.date}T${v.startTime}`, tz);
    if (!start) return { status: 'error', code: 'validation', fieldErrors: { date: ['date_invalid'] } };
    const end = new Date(start.getTime() + v.minutes * 60_000);
    const db = await createUserClient();
    const { data, error } = await db
      .from('lesson_sessions')
      .update({
        period: `[${start.toISOString()},${end.toISOString()})`,
        classroom_id: v.classroomId ?? null,
        online_url: v.onlineUrl ?? null,
        change_note: v.note ?? null,
      })
      .eq('id', v.sessionId)
      .select('id');
    if (error?.code === '23P01') return conflictState(form, error, v.date);
    if (error?.message?.includes('cannot be')) return { status: 'error', code: 'forbidden' };
    return dbState(error, data);
  }, STAFF);
}

export async function cancelSessionAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(CancelSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('lesson_sessions')
      .update({ status: 'cancelled', cancel_reason: r.data.reason, change_note: null })
      .eq('id', r.data.sessionId)
      .neq('status', 'cancelled')
      .select('id');
    if (error?.message?.includes('cannot be')) return { status: 'error', code: 'forbidden' };
    return dbState(error, data);
  }, STAFF);
}

export async function markAttendanceAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const sessionId = idOf(form, 'sessionId');
    if (!sessionId) return { status: 'error', code: 'validation' };
    const ids = form.getAll('studentIds').filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
    const { marks, invalid } = marksFromForm(form, ids);
    if (invalid.length) return { status: 'error', code: 'validation', fieldErrors: { marks: ['status_invalid'] } };
    if (marks.length === 0) return { status: 'error', code: 'validation', fieldErrors: { marks: ['marks_required'] } };
    const reason = String(form.get('reason') ?? '').trim();
    const db = await createUserClient();
    const { data, error } = await db.rpc('mark_attendance', { p_session: sessionId, p_marks: marks, p_reason: reason || null });
    if (error?.message?.includes('requires a reason')) return { status: 'error', code: 'validation', fieldErrors: { reason: ['reason_required'] } };
    if (error?.message?.includes('not enrolled')) return { status: 'error', code: 'validation' };
    if (error) return dbState(error);
    return { status: 'success', code: 'attendance_saved', data: { count: String(data ?? 0) } };
  }, PERSON);
}

export async function openCodeAction(_p: FormState, form: FormData) {
  return runAction(form, [], async () => {
    const sessionId = idOf(form, 'sessionId');
    if (!sessionId) return { status: 'error', code: 'validation' };
    const db = await createUserClient();
    const { data, error } = await db.rpc('open_attendance_code', { p_session: sessionId });
    if (error?.message?.includes('has ended')) return { status: 'error', code: 'forbidden' };
    if (error) return dbState(error);
    const r = data as { code: string; expiresAt: string };
    const tz = (await sessionZone(sessionId)) ?? DEFAULT_TIMEZONE;
    return { status: 'success', code: 'code_opened', data: { code: r.code, until: timeIn(localeOf(form), r.expiresAt, tz) } };
  }, PERSON);
}

export async function checkInAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(CheckInSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.rpc('check_in_with_code', { p_code: r.data.code });
    if (error?.message?.includes('too many attempts')) return { status: 'error', code: 'rate_limited' };
    if (error) return dbState(error);
    if (!data) return { status: 'error', code: 'invalid_code' };
    return { status: 'success', code: 'checked_in' };
  }, PERSON);
}

export async function confirmCameraEventAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const eventId = idOf(form, 'eventId');
    if (!eventId) return { status: 'error', code: 'validation' };
    const db = await createUserClient();
    const { error } = await db.rpc('confirm_camera_event', { p_event: eventId, p_reason: null });
    return dbState(error);
  }, PERSON);
}

export async function markNotificationsReadAction(_p: FormState, form: FormData) {
  return runAction(form, ['/app/notifications'], async (userId) => {
    const db = await createUserClient();
    const { error } = await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', userId).is('read_at', null);
    return dbState(error);
  }, PERSON);
}
