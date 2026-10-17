'use server';

import { z } from 'zod';
import { dbState, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';

/**
 * Автоматизация: счета за месяц, зарплата, отработки, замена преподавателя.
 * Права, переходы и расчёты — в БД (функции billing_*, payroll_*, makeup_*, session_substitute).
 */
const FINANCE = { mfa: true };
const STAFF = { mfa: false };
const uuid = z.uuid();
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month_invalid' });
const blank = (v: unknown) => (v === '' ? undefined : v);

function rpcState(error: { code?: string; message?: string } | null): FormState | null {
  if (!error) return null;
  const m = error.message ?? '';
  if (/mfa required/.test(m)) return { status: 'error', code: 'mfa_required' };
  if (/reason required/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { note: ['reason_required'] } };
  if (/active teacher/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { teacherId: ['role_invalid'] } };
  if (/teacher_excl|conflicting key/.test(m)) return { status: 'error', code: 'validation', fieldErrors: { teacherId: ['duplicate'] } };
  return null;
}

export async function billingGenerateAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/finance'], async () => {
    const r = parseForm(z.object({ organizationId: uuid, month: MONTH, dueDay: z.coerce.number().int().min(1).max(28) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.rpc('billing_generate', { p_org: r.data.organizationId, p_month: `${r.data.month}-01`, p_due_day: r.data.dueDay });
    if (error) return rpcState(error) ?? dbState(error);
    const d = data as { created: number; existing: number; noTariff: unknown[] };
    return { status: 'success', code: 'billing_done', data: { created: String(d.created), existing: String(d.existing), noTariff: String(d.noTariff.length) } };
  }, FINANCE);
}

export async function billingIssueAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/finance'], async () => {
    const r = parseForm(z.object({ organizationId: uuid, month: MONTH }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.rpc('billing_issue', { p_org: r.data.organizationId, p_month: `${r.data.month}-01` });
    if (error) return rpcState(error) ?? dbState(error);
    const d = data as { issued: number; failed: unknown[] };
    return { status: 'success', code: 'billing_issued', data: { issued: String(d.issued), failed: String(d.failed.length) } };
  }, FINANCE);
}

const Rate = z.object({
  organizationId: uuid,
  branchId: z.preprocess(blank, uuid.optional()),
  teacherId: uuid,
  amount: z.string().trim().regex(/^\d{1,9}([.,]\d{1,2})?$/, { message: 'amount_invalid' }).transform((v) => v.replace(',', '.')),
  currency: z.string().regex(/^[A-Z]{3}$/, { message: 'amount_invalid' }),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' }),
});

export async function addRateAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/payroll'], async (userId) => {
    const r = parseForm(Rate, form);
    if (!r.ok) return r.state;
    const v = r.data;
    if (Number(v.amount) <= 0) return { status: 'error', code: 'validation', fieldErrors: { amount: ['amount_invalid'] } };
    const db = await createUserClient();
    const { error } = await db.from('teacher_rates').insert({
      organization_id: v.organizationId, branch_id: v.branchId ?? null, teacher_id: v.teacherId, amount: v.amount, currency: v.currency, valid_from: v.validFrom, created_by: userId,
    });
    return rpcState(error) ?? dbState(error);
  }, FINANCE);
}

export async function payrollGenerateAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/payroll'], async () => {
    const r = parseForm(z.object({ organizationId: uuid, month: MONTH }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.rpc('payroll_generate', { p_org: r.data.organizationId, p_month: `${r.data.month}-01` });
    if (error) return rpcState(error) ?? dbState(error);
    const d = data as { statements: number; noRate: unknown[] };
    return { status: 'success', code: 'payroll_done', data: { statements: String(d.statements), noRate: String(d.noRate.length) } };
  }, FINANCE);
}

export async function payrollDecisionAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/payroll', '/app/finance'], async () => {
    const r = parseForm(z.object({ statementId: uuid, decision: z.enum(['approve', 'pay']) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc(r.data.decision === 'approve' ? 'payroll_approve' : 'payroll_pay', { p_id: r.data.statementId });
    return rpcState(error) ?? dbState(error);
  }, FINANCE);
}

export async function makeupScheduleAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/schedule'], async () => {
    const r = parseForm(z.object({ requestId: uuid, sessionId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('makeup_schedule', { p_request: r.data.requestId, p_session: r.data.sessionId });
    return rpcState(error) ?? dbState(error);
  }, STAFF);
}

export async function makeupResolveAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/schedule'], async () => {
    const r = parseForm(z.object({ requestId: uuid, status: z.enum(['done', 'cancelled']), note: z.preprocess(blank, z.string().trim().max(500).optional()) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('makeup_resolve', { p_request: r.data.requestId, p_status: r.data.status, p_note: r.data.note ?? null });
    return rpcState(error) ?? dbState(error);
  }, STAFF);
}

export async function substituteAction(_p: FormState, form: FormData): Promise<FormState> {
  return runAction(form, ['/app/schedule'], async () => {
    const r = parseForm(z.object({ sessionId: uuid, teacherId: uuid, note: z.preprocess(blank, z.string().trim().max(300).optional()) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { error } = await db.rpc('session_substitute', { p_session: r.data.sessionId, p_teacher: r.data.teacherId, p_reason: r.data.note ?? null });
    return rpcState(error) ?? dbState(error);
  }, STAFF);
}
