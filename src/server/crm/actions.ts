'use server';

import type { PostgrestError } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DEFAULT_TIMEZONE, zonedLocalToUtc } from '@/lib/time';
import { dbState, localeOf, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';
import { CHANNELS, SOURCES, STAGES } from './constants';
import { MAX_IMPORT_BYTES, rowsForImport } from './csv';

/** Все действия CRM — сотрудники с lead.manage / crm.admin, MFA (как политики БД). */
const STAFF = { mfa: true };
const PATHS = ['/app/crm', '/app/requests'];
const uuid = z.uuid();
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = (max: number) => z.preprocess(blank, z.string().trim().max(max, { message: 'message_too_long' }).optional());


const ContactFields = {
  fullName: z.string().trim().min(1, { message: 'name_required' }).max(120, { message: 'name_too_long' }),
  phone: z.preprocess(blank, z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, { message: 'phone_invalid' }).optional()),
  email: z.preprocess(blank, z.email({ message: 'email_invalid' }).max(254).optional()),
  note: optional(2000),
};
const reachable = (v: { phone?: string | undefined; email?: string | undefined }) => Boolean(v.phone || v.email);

const CreateSchema = z
  .object({ organizationId: uuid, branchId: z.preprocess(blank, uuid.optional()), source: z.enum(SOURCES), ...ContactFields })
  .refine(reachable, { message: 'contact_required', path: ['phone'], when: () => true });
const UpdateSchema = z.object({ contactId: uuid, source: z.enum(SOURCES), ...ContactFields }).refine(reachable, { message: 'contact_required', path: ['phone'], when: () => true });

const duplicate = (error: { code?: string; message?: string } | null): FormState | null =>
  error?.code === '23505' && /crm_contacts_(phone|email)_key/.test(error.message ?? '')
    ? { status: 'error', code: 'validation', fieldErrors: { [error.message!.includes('email') ? 'email' : 'phone']: ['duplicate'] } }
    : null;

export async function createContactAction(_p: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const state = await runAction(form, PATHS, async (userId) => {
    const r = parseForm(CreateSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data, error } = await db
      .from('crm_contacts')
      .insert({ organization_id: v.organizationId, branch_id: v.branchId ?? null, full_name: v.fullName, phone: v.phone ?? null, email: v.email ?? null, source: v.source, note: v.note ?? null, owner_id: userId, created_by: userId })
      .select('id')
      .single();
    if (error) return duplicate(error) ?? dbState(error);
    id = data.id as string;
    return { status: 'success', code: 'saved' };
  }, STAFF);
  if (id) redirect(`/${localeOf(form)}/app/crm/contacts/${id}`);
  return state;
}

export async function updateContactAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(UpdateSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data, error } = await db
      .from('crm_contacts')
      .update({ full_name: v.fullName, phone: v.phone ?? null, email: v.email ?? null, source: v.source, note: v.note ?? null })
      .eq('id', v.contactId)
      .select('id');
    return duplicate(error) ?? dbState(error, data);
  }, STAFF);
}

const StageSchema = z
  .object({ contactId: uuid, stage: z.enum(STAGES).exclude(['won']), lostReason: optional(300) })
  .refine((v) => v.stage !== 'lost' || Boolean(v.lostReason), { message: 'reason_required', path: ['lostReason'], when: () => true });

export async function setStageAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(StageSchema, form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('crm_contacts').update({ stage: r.data.stage, lost_reason: r.data.lostReason ?? null }).eq('id', r.data.contactId).select('id');
    return dbState(error, data);
  }, STAFF);
}

export async function assignOwnerAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ contactId: uuid, ownerId: z.preprocess(blank, uuid.optional()) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('crm_contacts').update({ owner_id: r.data.ownerId ?? null }).eq('id', r.data.contactId).select('id');
    if (error?.message?.includes('owner must be')) return { status: 'error', code: 'validation', fieldErrors: { ownerId: ['role_invalid'] } };
    return dbState(error, data);
  }, STAFF);
}

const LogSchema = z.object({
  contactId: uuid,
  organizationId: uuid,
  kind: z.enum(['call', 'message', 'meeting', 'note']),
  channel: z.preprocess(blank, z.enum(CHANNELS).optional()),
  body: z.string().trim().min(1, { message: 'body_required' }).max(4000, { message: 'message_too_long' }),
});

export async function logCommunicationAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(LogSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db
      .from('crm_events')
      .insert({ organization_id: v.organizationId, contact_id: v.contactId, kind: v.kind, channel: v.channel ?? null, body: v.body, actor_id: userId });
    return dbState(error);
  }, STAFF);
}

const ReminderSchema = z.object({
  contactId: uuid,
  organizationId: uuid,
  assigneeId: uuid,
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'start_invalid' }),
  timezone: z.string().max(64).default(DEFAULT_TIMEZONE),
  note: optional(500),
});

export async function addReminderAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(ReminderSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const due = zonedLocalToUtc(v.dueAt, v.timezone);
    if (!due) return { status: 'error', code: 'validation', fieldErrors: { dueAt: ['start_invalid'] } };
    const db = await createUserClient();
    const { error } = await db
      .from('crm_reminders')
      .insert({ organization_id: v.organizationId, contact_id: v.contactId, assignee_id: v.assigneeId, due_at: due.toISOString(), note: v.note ?? null, created_by: userId });
    if (error?.message?.includes('assignee must be')) return { status: 'error', code: 'validation', fieldErrors: { assigneeId: ['role_invalid'] } };
    return dbState(error);
  }, STAFF);
}

export async function completeReminderAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ reminderId: uuid, status: z.enum(['done', 'cancelled']) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('crm_reminders')
      .update({ status: r.data.status, done_at: new Date().toISOString() })
      .eq('id', r.data.reminderId)
      .eq('status', 'open')
      .select('id');
    return dbState(error, data);
  }, STAFF);
}

const rpcState = (error: PostgrestError | null, map: [string, FormState][] = []): FormState => {
  for (const [needle, state] of map) if (error?.message?.includes(needle)) return state;
  return dbState(error);
};

export async function bookTrialAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ contactId: uuid, slotId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('crm_book_trial', { p_contact: r.data.contactId, p_slot: r.data.slotId });
    return rpcState(error, [
      ['slot is full', { status: 'error', code: 'slot_full' }],
      ['slot not available', { status: 'error', code: 'slot_unavailable' }],
      ['duplicate key', { status: 'error', code: 'validation', fieldErrors: { slotId: ['duplicate'] } }],
    ]);
  }, STAFF);
}

export async function trialResultAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ bookingId: uuid, status: z.enum(['attended', 'no_show', 'cancelled']) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('crm_trial_result', { p_booking: r.data.bookingId, p_status: r.data.status });
    return rpcState(error);
  }, STAFF);
}

export async function convertAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ contactId: uuid, profileId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('crm_convert', { p_contact: r.data.contactId, p_profile: r.data.profileId });
    return rpcState(error, [
      ['not a student', { status: 'error', code: 'validation', fieldErrors: { profileId: ['role_invalid'] } }],
      ['duplicate key', { status: 'error', code: 'validation', fieldErrors: { profileId: ['duplicate'] } }],
    ]);
  }, STAFF);
}

export async function enrollAction(_p: FormState, form: FormData) {
  return runAction(form, [...PATHS, '/app/groups'], async () => {
    const r = parseForm(z.object({ contactId: uuid, groupId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('crm_enroll', { p_contact: r.data.contactId, p_group: r.data.groupId });
    return rpcState(error, [
      ['group is full', { status: 'error', code: 'validation', fieldErrors: { groupId: ['capacity_invalid'] } }],
      ['duplicate key', { status: 'error', code: 'validation', fieldErrors: { groupId: ['duplicate'] } }],
    ]);
  }, STAFF);
}

export async function eraseContactAction(_p: FormState, form: FormData): Promise<FormState> {
  let done = false;
  const state = await runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ contactId: uuid, reason: z.string().trim().min(3, { message: 'reason_required' }).max(300, { message: 'reason_required' }) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('crm_erase', { p_contact: r.data.contactId, p_reason: r.data.reason });
    if (error) return rpcState(error);
    done = true;
    return { status: 'success', code: 'saved' };
  }, STAFF);
  if (done) redirect(`/${localeOf(form)}/app/crm`);
  return state;
}

export async function importContactsAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ organizationId: uuid, branchId: z.preprocess(blank, uuid.optional()) }), form);
    if (!r.ok) return r.state;
    const file = form.get('file');
    const pasted = String(form.get('csv') ?? '');
    let text = pasted;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_IMPORT_BYTES) return { status: 'error', code: 'validation', fieldErrors: { file: ['message_too_long'] } };
      text = await file.text();
    }
    if (text.length > MAX_IMPORT_BYTES) return { status: 'error', code: 'validation', fieldErrors: { file: ['message_too_long'] } };
    const parsed = rowsForImport(text);
    if (parsed.error) return { status: 'error', code: 'validation', fieldErrors: { file: [parsed.error === 'too_many' ? 'count_invalid' : 'body_required'] } };
    const db = await createUserClient();
    const { data, error } = await db.rpc('crm_import', { p_org: r.data.organizationId, p_branch: r.data.branchId ?? null, p_rows: parsed.rows });
    if (error) return rpcState(error);
    const res = data as { created: number; duplicates: number[]; invalid: number[] };
    // Номера строк в файле: +1 за заголовок.
    const lines = (list: number[]) => (list.length ? list.slice(0, 50).map((n) => n + 1).join(', ') : '—');
    return {
      status: 'success',
      code: 'imported',
      data: { created: String(res.created), duplicates: lines(res.duplicates), invalid: lines(res.invalid) },
    };
  }, STAFF);
}
