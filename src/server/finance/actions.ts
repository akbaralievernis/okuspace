'use server';

import type { PostgrestError } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { zonedLocalToUtc } from '@/lib/time';
import { dbState, localeOf, parseForm, runAction } from '@/server/actions-util';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';
import { EXPENSE_CATEGORIES, METHODS, TARIFF_UNITS, compareMoney as cmp } from './constants';

/** Все действия с деньгами — сотрудники с MFA; права и суммы окончательно проверяет БД. */
const STAFF = { mfa: true };
const PATHS = ['/app/finance', '/app/billing'];
const uuid = z.uuid();
const blank = (v: unknown) => (v === '' ? undefined : v);
/** Деньги — строкой с точной десятичной записью; float не участвует. */
const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, { message: 'amount_invalid' }).refine((v) => Number(v.replace('.', '')) > 0, { message: 'amount_invalid' });
const reason = z.string().trim().min(3, { message: 'reason_required' }).max(500, { message: 'reason_required' });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_invalid' });

/** Ошибки БД финансов → понятные коды. */
function financeState(error: PostgrestError | null, rows?: unknown[] | null): FormState {
  const m = error?.message ?? '';
  if (/financial period .* is closed/.test(m)) return { status: 'error', code: 'period_closed' };
  if (/exceed/.test(m)) return { status: 'error', code: 'amount_exceeds' };
  if (m.includes('pending discounts')) return { status: 'error', code: 'pending_discounts' };
  if (error?.code === '23505' && m.includes('invoices_number_key')) return { status: 'error', code: 'validation', fieldErrors: { number: ['duplicate'] } };
  return dbState(error, rows);
}

// --- Счета ---------------------------------------------------------------------
const InvoiceSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  payerId: uuid,
  number: z.string().trim().regex(/^[A-Za-z0-9/._-]{1,40}$/, { message: 'title_required' }),
  currency: z.string().regex(/^[A-Z]{3}$/).default('KGS'),
  dueOn: z.preprocess(blank, date.optional()),
  description: z.preprocess(blank, z.string().trim().max(2000).optional()),
});

export async function createInvoiceAction(_p: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const state = await runAction(form, PATHS, async (userId) => {
    const r = parseForm(InvoiceSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { data, error } = await db
      .from('invoices')
      .insert({ organization_id: v.organizationId, branch_id: v.branchId, payer_id: v.payerId, number: v.number, currency: v.currency, total: 0, status: 'draft', due_on: v.dueOn ?? null, description: v.description ?? null, created_by: userId })
      .select('id')
      .single();
    if (error) return financeState(error);
    id = data.id as string;
    return { status: 'success', code: 'saved' };
  }, STAFF);
  if (id) redirect(`/${localeOf(form)}/app/finance/invoices/${id}`);
  return state;
}

const LineSchema = z.object({
  invoiceId: uuid,
  organizationId: uuid,
  branchId: uuid,
  tariffId: z.preprocess(blank, uuid.optional()),
  description: z.string().trim().min(1, { message: 'title_required' }).max(300, { message: 'title_required' }),
  quantity: z.string().trim().regex(/^\d{1,4}(\.\d{1,2})?$/, { message: 'amount_invalid' }),
  // С тарифом цену подставит БД из прайс-листа; без тарифа — обязательна.
  unitPrice: z.preprocess(blank, money.optional()),
}).refine((v) => v.tariffId || v.unitPrice, { message: 'amount_invalid', path: ['unitPrice'], when: () => true });

export async function addLineAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(LineSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('invoice_lines').insert({
      organization_id: v.organizationId, branch_id: v.branchId, invoice_id: v.invoiceId, tariff_id: v.tariffId ?? null,
      description: v.description, quantity: v.quantity, unit_price: v.unitPrice ?? '0',
    });
    return financeState(error);
  }, STAFF);
}

export async function removeLineAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ lineId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('invoice_lines').delete().eq('id', r.data.lineId).select('id');
    return financeState(error, data);
  }, STAFF);
}

export async function issueInvoiceAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ invoiceId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('invoices').update({ status: 'issued' }).eq('id', r.data.invoiceId).eq('status', 'draft').select('id');
    return financeState(error, data);
  }, STAFF);
}

export async function voidInvoiceAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ invoiceId: uuid, reason }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('invoices').update({ status: 'void', void_reason: r.data.reason }).eq('id', r.data.invoiceId).eq('status', 'issued').select('id');
    return financeState(error, data);
  }, STAFF);
}

// --- Скидки и корректировки -------------------------------------------------------
const AdjustmentSchema = z.object({ invoiceId: uuid, organizationId: uuid, branchId: uuid, kind: z.enum(['discount', 'credit', 'debit']), amount: money, reason });

export async function requestAdjustmentAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(AdjustmentSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('invoice_adjustments').insert({
      organization_id: v.organizationId, branch_id: v.branchId, invoice_id: v.invoiceId, kind: v.kind, amount: v.amount, reason: v.reason, requested_by: userId,
    });
    return financeState(error);
  }, STAFF);
}

export async function decideAdjustmentAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ adjustmentId: uuid, decision: z.enum(['approved', 'rejected']), note: z.preprocess(blank, z.string().trim().max(500).optional()) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db
      .from('invoice_adjustments')
      .update({ status: r.data.decision, decided_by: userId, decided_at: new Date().toISOString(), decision_note: r.data.note ?? null })
      .eq('id', r.data.adjustmentId)
      .eq('status', 'pending')
      .select('id');
    if (error?.message?.includes('four_eyes')) return { status: 'error', code: 'forbidden' };
    return financeState(error, data);
  }, STAFF);
}

// --- Платежи, распределения, возвраты -------------------------------------------
const PaymentSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  payerId: uuid,
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/).default('KGS'),
  method: z.enum(METHODS).exclude(['online']),
  receivedAt: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'date_invalid' }).optional()),
  timezone: z.string().max(64).default('Asia/Bishkek'),
  invoiceId: z.preprocess(blank, uuid.optional()),
});

export async function recordPaymentAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(PaymentSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const received = v.receivedAt ? zonedLocalToUtc(v.receivedAt, v.timezone) : new Date();
    if (!received) return { status: 'error', code: 'validation', fieldErrors: { receivedAt: ['date_invalid'] } };
    const db = await createUserClient();
    const { data, error } = await db
      .from('payments')
      .insert({ organization_id: v.organizationId, branch_id: v.branchId, payer_id: v.payerId, kind: 'payment', amount: v.amount, currency: v.currency, method: v.method, received_at: received.toISOString(), created_by: userId })
      .select('id')
      .single();
    if (error) return financeState(error);
    if (v.invoiceId) {
      // Зачесть сразу — не больше остатка счёта (остаток считает БД).
      const { data: bal } = await db.from('invoice_balances').select('outstanding').eq('invoice_id', v.invoiceId).maybeSingle();
      const outstanding = String(bal?.outstanding ?? '0');
      const amount = cmp(v.amount, outstanding) <= 0 ? v.amount : outstanding;
      if (cmp(amount, '0') > 0) {
        const { error: e2 } = await db.from('payment_allocations').insert({ organization_id: v.organizationId, branch_id: v.branchId, payment_id: data.id, invoice_id: v.invoiceId, amount, created_by: userId });
        if (e2) return financeState(e2);
      }
    }
    return { status: 'success', code: 'saved' };
  }, STAFF);
}

export async function allocateAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ paymentId: uuid, invoiceId: uuid, organizationId: uuid, branchId: uuid, amount: money }), form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('payment_allocations').insert({ organization_id: v.organizationId, branch_id: v.branchId, payment_id: v.paymentId, invoice_id: v.invoiceId, amount: v.amount, created_by: userId });
    return financeState(error);
  }, STAFF);
}

export async function releaseAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ allocationId: uuid, paymentId: uuid, invoiceId: uuid, organizationId: uuid, branchId: uuid, amount: money, reason }), form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('payment_allocations').insert({
      organization_id: v.organizationId, branch_id: v.branchId, payment_id: v.paymentId, invoice_id: v.invoiceId, amount: v.amount,
      kind: 'release', reverses_allocation_id: v.allocationId, reason: v.reason, created_by: userId,
    });
    return financeState(error);
  }, STAFF);
}

export async function refundAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ paymentId: uuid, amount: money, reason }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data: p } = await db.from('payments').select('organization_id, branch_id, payer_id, currency, method').eq('id', r.data.paymentId).maybeSingle();
    if (!p) return { status: 'error', code: 'forbidden' };
    const { error } = await db.from('payments').insert({
      organization_id: p.organization_id, branch_id: p.branch_id, payer_id: p.payer_id, kind: 'refund', amount: r.data.amount, currency: p.currency,
      method: p.method === 'online' ? 'bank_transfer' : p.method, reverses_payment_id: r.data.paymentId, reason: r.data.reason, created_by: userId,
    });
    return financeState(error);
  }, STAFF);
}

// --- Расходы ----------------------------------------------------------------------
const ExpenseSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/).default('KGS'),
  spentOn: date,
  description: z.string().trim().min(1, { message: 'title_required' }).max(500, { message: 'title_required' }),
  vendor: z.preprocess(blank, z.string().trim().max(200).optional()),
  documentRef: z.preprocess(blank, z.string().trim().max(100).optional()),
});

export async function recordExpenseAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(ExpenseSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('expenses').insert({
      organization_id: v.organizationId, branch_id: v.branchId, category: v.category, amount: v.amount, currency: v.currency, spent_on: v.spentOn,
      description: v.description, vendor: v.vendor ?? null, document_ref: v.documentRef ?? null, created_by: userId,
    });
    return financeState(error);
  }, STAFF);
}

export async function reverseExpenseAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ expenseId: uuid, reason }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data: e } = await db.from('expenses').select('*').eq('id', r.data.expenseId).maybeSingle();
    if (!e) return { status: 'error', code: 'forbidden' };
    const { error } = await db.from('expenses').insert({
      organization_id: e.organization_id, branch_id: e.branch_id, category: e.category, amount: e.amount, currency: e.currency, spent_on: e.spent_on,
      description: `${String(e.description).slice(0, 480)} (сторно)`, reverses_expense_id: e.id, reason: r.data.reason, created_by: userId,
    });
    if (error?.code === '23505') return { status: 'error', code: 'validation', fieldErrors: { reason: ['duplicate'] } };
    return financeState(error);
  }, STAFF);
}

// --- Прайс-листы и тарифы ------------------------------------------------------------
const PriceListSchema = z.object({
  organizationId: uuid,
  branchId: z.preprocess(blank, uuid.optional()),
  name: z.string().trim().min(1, { message: 'title_required' }).max(120, { message: 'title_required' }),
  currency: z.string().regex(/^[A-Z]{3}$/).default('KGS'),
  validFrom: date,
  validTo: z.preprocess(blank, date.optional()),
}).refine((v) => !v.validTo || v.validTo >= v.validFrom, { message: 'date_invalid', path: ['validTo'], when: () => true });

export async function createPriceListAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(PriceListSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('price_lists').insert({
      organization_id: v.organizationId, branch_id: v.branchId ?? null, name: v.name, currency: v.currency, valid_from: v.validFrom, valid_to: v.validTo ?? null, status: 'draft', created_by: userId,
    });
    return financeState(error);
  }, STAFF);
}

export async function setPriceListStatusAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ priceListId: uuid, status: z.enum(['draft', 'active', 'archived']) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('price_lists').update({ status: r.data.status }).eq('id', r.data.priceListId).select('id');
    return financeState(error, data);
  }, STAFF);
}

const TariffSchema = z.object({
  organizationId: uuid,
  priceListId: uuid,
  courseId: z.preprocess(blank, uuid.optional()),
  name: z.string().trim().min(1, { message: 'title_required' }).max(120, { message: 'title_required' }),
  unit: z.enum(TARIFF_UNITS),
  lessons: z.preprocess(blank, z.coerce.number().int().min(1).max(500).optional()),
  amount: money,
});

export async function addTariffAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(TariffSchema, form);
    if (!r.ok) return r.state;
    const v = r.data;
    const db = await createUserClient();
    const { error } = await db.from('tariffs').insert({
      organization_id: v.organizationId, price_list_id: v.priceListId, course_id: v.courseId ?? null, name: v.name, unit: v.unit, lessons: v.lessons ?? null, amount: v.amount,
    });
    return financeState(error);
  }, STAFF);
}

export async function archiveTariffAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async () => {
    const r = parseForm(z.object({ tariffId: uuid }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('tariffs').update({ status: 'archived' }).eq('id', r.data.tariffId).select('id');
    return financeState(error, data);
  }, STAFF);
}

// --- Периоды ----------------------------------------------------------------------
export async function closePeriodAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ organizationId: uuid, month: z.string().regex(/^\d{4}-\d{2}$/, { message: 'date_invalid' }) }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const month = `${r.data.month}-01`;
    const { data: existing } = await db.from('finance_periods').select('id').eq('organization_id', r.data.organizationId).eq('period_month', month).maybeSingle();
    const { data, error } = existing
      ? await db.from('finance_periods').update({ status: 'closed', reason: null, changed_by: userId }).eq('id', existing.id).select('id')
      : await db.from('finance_periods').insert({ organization_id: r.data.organizationId, period_month: month, status: 'closed', changed_by: userId }).select('id');
    return financeState(error, data);
  }, STAFF);
}

export async function reopenPeriodAction(_p: FormState, form: FormData) {
  return runAction(form, PATHS, async (userId) => {
    const r = parseForm(z.object({ periodId: uuid, reason }), form);
    if (!r.ok) return r.state;
    const db = await createUserClient();
    const { data, error } = await db.from('finance_periods').update({ status: 'open', reason: r.data.reason, changed_by: userId }).eq('id', r.data.periodId).select('id');
    return financeState(error, data);
  }, STAFF);
}
