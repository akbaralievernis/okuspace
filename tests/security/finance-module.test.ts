import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, INVOICE, ORG, PAYMENT, U, createSeededDb } from '../db/fixtures';
import { as, asService, count, rows, type Tx } from '../db/harness';

/**
 * Этап 9: прайс-листы, строки счёта, скидки и корректировки с утверждением (четыре глаза),
 * освобождение распределений и возвраты, расходы со сторно, финансовые периоды,
 * платежи провайдера (повтор webhook), отчёты и долги.
 * В фикстурах: счёт A1 5000 (studentA1, выставлен), платёж A1 3000; счёт A2 5000 и платёж A2 5000 (studentA2).
 */
let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const MFA = { aal: 'aal2' as const };
/** Сменить пользователя (с MFA) внутри транзакции; null — service role. */
const switchTo = (tx: Tx, sub: string | null, aal: 'aal1' | 'aal2' = 'aal2') =>
  sub === null
    ? tx.exec('set local role service_role')
    : tx.exec('set local role authenticated').then(() => tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal })]));
const one = async <T,>(tx: Tx, sql: string, params: unknown[] = []) => (await rows<T>(tx, sql, params))[0]!;
const attempt = async (tx: Tx, sql: string, params: unknown[] = []) => {
  await tx.exec('savepoint a');
  try {
    const r = await tx.query(sql, params);
    return `ok:${r.affectedRows ?? 0}`;
  } catch (e) {
    await tx.exec('rollback to savepoint a');
    return (e as Error).message;
  }
};

/** Прайс-лист с тарифом 4500/мес (директор). */
const priceList = async (tx: Tx) => {
  await switchTo(tx, U.directorA);
  const list = (await one<{ id: string }>(tx, `insert into public.price_lists (organization_id, name, valid_from, status, created_by) values ($1, 'Базовый 2026', '2026-09-01', 'active', $2) returning id`, [ORG.A, U.directorA])).id;
  const tariff = (await one<{ id: string }>(tx, `insert into public.tariffs (organization_id, price_list_id, course_id, name, unit, lessons, amount) values ($1, $2, $3, 'Группа, месяц', 'month', 8, 4500.00) returning id`, [ORG.A, list, COURSE.A])).id;
  return { list, tariff };
};

/** Черновик счёта бухгалтера для studentA1 со строкой тарифа × количество. */
const draftInvoice = async (tx: Tx, tariff: string, qty = '2', number = 'A-0100') => {
  await switchTo(tx, U.accountantA);
  const id = (await one<{ id: string }>(tx, `insert into public.invoices (organization_id, branch_id, payer_id, number, total, status, created_by) values ($1, $2, $3, $4, 0, 'draft', $5) returning id`, [ORG.A, BRANCH.A1, U.studentA1, number, U.accountantA])).id;
  await tx.query(`insert into public.invoice_lines (organization_id, branch_id, invoice_id, tariff_id, description, quantity, unit_price) values ($1, $2, $3, $4, 'Английский A1', $5, 1.00)`, [ORG.A, BRANCH.A1, id, tariff, qty]);
  return id;
};
const totalOf = async (tx: Tx, id: string) => (await one<{ t: string }>(tx, 'select total::text as t from public.invoices where id = $1', [id])).t;

describe('price lists and invoice lines: amounts are computed by the server', () => {
  it('the price comes from the tariff, the total from the lines; a manual total is overridden', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      const { tariff } = await priceList(tx);
      const inv = await draftInvoice(tx, tariff);
      const afterLines = await totalOf(tx, inv);
      await tx.query(`update public.invoices set total = 1.00 where id = $1`, [inv]);
      return { afterLines, afterForge: await totalOf(tx, inv), unit: (await one<{ u: string }>(tx, 'select unit_price::text as u from public.invoice_lines where invoice_id = $1', [inv])).u };
    }, MFA);
    expect(r).toEqual({ afterLines: '9000.00', afterForge: '9000.00', unit: '4500.00' });
  });

  it('tariff prices are immutable; only approvers manage price lists', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      const { tariff, list } = await priceList(tx);
      const changePrice = await attempt(tx, `update public.tariffs set amount = 1.00 where id = $1`, [tariff]);
      await switchTo(tx, U.accountantA);
      const accountant = await attempt(tx, `insert into public.price_lists (organization_id, name, valid_from, created_by) values ($1, 'x', '2026-10-01', $2)`, [ORG.A, U.accountantA]);
      const archive = await attempt(tx, `update public.tariffs set status = 'archived' where id = $1`, [tariff]);
      void list;
      return { changePrice, accountant, archive };
    }, MFA);
    expect(r.changePrice).toMatch(/permission denied|immutable/);
    expect(r.accountant).toMatch(/row-level security/);
    expect(r.archive).toBe('ok:0');
  });

  it('lines cannot change once the invoice is issued', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      const { tariff } = await priceList(tx);
      const inv = await draftInvoice(tx, tariff);
      await tx.query(`update public.invoices set status = 'issued' where id = $1`, [inv]);
      return attempt(tx, `update public.invoice_lines set quantity = 1 where invoice_id = $1`, [inv]);
    }, MFA);
    expect(r).toMatch(/only on a draft invoice/);
  });
});

describe('discounts need approval by another person', () => {
  it('a pending discount blocks issuing; the accountant cannot approve; the director can', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      const { tariff } = await priceList(tx);
      const inv = await draftInvoice(tx, tariff);
      const adj = (await one<{ id: string }>(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'discount', 900.00, 'Скидка 10% за второго ребёнка', $4) returning id`, [ORG.A, BRANCH.A1, inv, U.accountantA])).id;
      const issueBlocked = await attempt(tx, `update public.invoices set status = 'issued' where id = $1`, [inv]);
      const selfApprove = await attempt(tx, `update public.invoice_adjustments set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [adj, U.accountantA]);
      await switchTo(tx, U.directorA);
      await tx.query(`update public.invoice_adjustments set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [adj, U.directorA]);
      const total = await totalOf(tx, inv);
      const again = await attempt(tx, `update public.invoice_adjustments set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [adj, U.directorA]);
      await switchTo(tx, U.accountantA);
      await tx.query(`update public.invoices set status = 'issued' where id = $1`, [inv]);
      return { issueBlocked, selfApprove, total, again, history: await rows(tx, 'select from_status, to_status from public.invoice_status_history where invoice_id = $1 order by id', [inv]) };
    }, MFA);
    expect(r.issueBlocked).toMatch(/pending discounts/);
    expect(r.selfApprove).toBe('ok:0'); // RLS: у бухгалтера нет finance.approve
    expect(r.total).toBe('8100.00');
    expect(r.again).toMatch(/already decided/);
    expect(r.history).toEqual([
      { from_status: null, to_status: 'draft' },
      { from_status: 'draft', to_status: 'issued' },
    ]);
  });

  it('nobody approves their own request; discounts cannot exceed the invoice', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      const { tariff } = await priceList(tx);
      const inv = await draftInvoice(tx, tariff, '1');
      const adj = (await one<{ id: string }>(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'discount', 5000.00, 'слишком большая', $4) returning id`, [ORG.A, BRANCH.A1, inv, U.accountantA])).id;
      const small = (await one<{ id: string }>(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'discount', 100.00, 'небольшая', $4) returning id`, [ORG.A, BRANCH.A1, inv, U.accountantA])).id;
      await switchTo(tx, null);
      const fourEyes = await attempt(tx, `update public.invoice_adjustments set status = 'approved', decided_by = requested_by, decided_at = now() where id = $1`, [small]);
      await switchTo(tx, U.directorA);
      const tooBig = await attempt(tx, `update public.invoice_adjustments set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [adj, U.directorA]);
      // Директор не создаёт финансовые записи сам (только утверждает).
      const directorRequest = await attempt(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'discount', 10.00, 'сам себе', $4)`, [ORG.A, BRANCH.A1, inv, U.directorA]);
      await switchTo(tx, U.accountantA);
      const onIssued = await attempt(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'discount', 10.00, 'late', $4)`, [ORG.A, BRANCH.A1, INVOICE.A1, U.accountantA]);
      return { fourEyes, tooBig, directorRequest, onIssued };
    }, MFA);
    expect(r.fourEyes).toMatch(/four_eyes/);
    expect(r.tooBig).toMatch(/exceed the invoice amount/);
    expect(r.directorRequest).toMatch(/row-level security/);
    expect(r.onIssued).toMatch(/discounts apply only to draft invoices/);
  });
});

describe('corrections and refunds as linked operations', () => {
  it('credit note on a paid invoice: release the allocation, approve the credit, refund — balances add up', async () => {
    const r = await as(db, U.accountantA, async (tx) => {
      await switchTo(tx, U.accountantA);
      const pay = (await one<{ id: string }>(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, created_by) values ($1, $2, $3, 'payment', 5000.00, 'KGS', 'cash', $4) returning id`, [ORG.A, BRANCH.A1, U.studentA1, U.accountantA])).id;
      const alloc = (await one<{ id: string }>(tx, `insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, created_by) values ($1, $2, $3, $4, 5000.00, $5) returning id`, [ORG.A, BRANCH.A1, pay, INVOICE.A1, U.accountantA])).id;
      const credit = (await one<{ id: string }>(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'credit', 1000.00, 'Пропуск по болезни, перерасчёт', $4) returning id`, [ORG.A, BRANCH.A1, INVOICE.A1, U.accountantA])).id;
      await switchTo(tx, U.directorA);
      const creditOnPaid = await attempt(tx, `update public.invoice_adjustments set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [credit, U.directorA]);
      await switchTo(tx, U.accountantA);
      const refundAllocated = await attempt(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, reverses_payment_id, reason, created_by) values ($1, $2, $3, 'refund', 1000.00, 'KGS', 'cash', $4, 'перерасчёт', $5)`, [ORG.A, BRANCH.A1, U.studentA1, pay, U.accountantA]);
      await tx.query(`insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, kind, reverses_allocation_id, reason, created_by) values ($1, $2, $3, $4, 1000.00, 'release', $5, 'Перерасчёт по болезни', $6)`, [ORG.A, BRANCH.A1, pay, INVOICE.A1, alloc, U.accountantA]);
      await switchTo(tx, U.directorA);
      await tx.query(`update public.invoice_adjustments set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [credit, U.directorA]);
      await switchTo(tx, U.accountantA);
      await tx.query(`insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, reverses_payment_id, reason, created_by) values ($1, $2, $3, 'refund', 1000.00, 'KGS', 'cash', $4, 'Перерасчёт по болезни', $5)`, [ORG.A, BRANCH.A1, U.studentA1, pay, U.accountantA]);
      const overRefund = await attempt(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, reverses_payment_id, reason, created_by) values ($1, $2, $3, 'refund', 0.01, 'KGS', 'cash', $4, 'ещё', $5)`, [ORG.A, BRANCH.A1, U.studentA1, pay, U.accountantA]);
      const overRelease = await attempt(tx, `insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, kind, reverses_allocation_id, reason, created_by) values ($1, $2, $3, $4, 4000.01, 'release', $5, 'слишком много', $6)`, [ORG.A, BRANCH.A1, pay, INVOICE.A1, alloc, U.accountantA]);
      return {
        creditOnPaid,
        refundAllocated,
        overRefund,
        overRelease,
        balance: await one(tx, 'select total::text, due::text, paid::text, outstanding::text, payment_status from public.invoice_balances where invoice_id = $1', [INVOICE.A1]),
      };
    }, MFA);
    expect(r.creditOnPaid).toMatch(/credit exceeds the unpaid amount/);
    expect(r.refundAllocated).toMatch(/exceeds the unallocated remainder/);
    expect(r.overRefund).toMatch(/exceeds the unallocated remainder/);
    expect(r.overRelease).toMatch(/release exceeds the allocation/);
    expect(r.balance).toEqual({ total: '5000.00', due: '4000.00', paid: '4000.00', outstanding: '0.00', payment_status: 'paid' });
  });

  it('a debit note increases what is owed; releases need the refund permission and a reason', async () => {
    const r = await as(db, U.accountantA, async (tx) => {
      await switchTo(tx, U.accountantA);
      const debit = (await one<{ id: string }>(tx, `insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'debit', 750.50, 'Учебник', $4) returning id`, [ORG.A, BRANCH.A1, INVOICE.A1, U.accountantA])).id;
      const pending = (await one<{ d: string }>(tx, 'select due::text as d from public.invoice_balances where invoice_id = $1', [INVOICE.A1])).d;
      await switchTo(tx, U.managerA1);
      await tx.query(`update public.invoice_adjustments set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [debit, U.managerA1]);
      const approved = (await one<{ d: string }>(tx, 'select due::text as d from public.invoice_balances where invoice_id = $1', [INVOICE.A1])).d;
      return { pending, approved };
    }, MFA);
    expect(r).toEqual({ pending: '5000.00', approved: '5750.50' });
  });
});

describe('expenses', () => {
  it('are append-only; corrections are mirrored reversals', async () => {
    const r = await as(db, U.accountantA, async (tx) => {
      await switchTo(tx, U.accountantA);
      const e = (await one<{ id: string }>(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, created_by) values ($1, $2, 'rent', 30000.00, current_date, 'Аренда за октябрь', $3) returning id`, [ORG.A, BRANCH.A1, U.accountantA])).id;
      const wrongMirror = await attempt(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, reverses_expense_id, reason, created_by) values ($1, $2, 'rent', 29000.00, current_date, 'сторно', $3, 'ошибка суммы', $4)`, [ORG.A, BRANCH.A1, e, U.accountantA]);
      const noReason = await attempt(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, reverses_expense_id, created_by) values ($1, $2, 'rent', 30000.00, current_date, 'сторно', $3, $4)`, [ORG.A, BRANCH.A1, e, U.accountantA]);
      await tx.query(`insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, reverses_expense_id, reason, created_by) values ($1, $2, 'rent', 30000.00, current_date, 'сторно', $3, 'ошибка суммы', $4)`, [ORG.A, BRANCH.A1, e, U.accountantA]);
      const twice = await attempt(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, reverses_expense_id, reason, created_by) values ($1, $2, 'rent', 30000.00, current_date, 'сторно', $3, 'ещё раз', $4)`, [ORG.A, BRANCH.A1, e, U.accountantA]);
      const edit = await attempt(tx, `update public.expenses set amount = 1 where id = $1`, [e]);
      await switchTo(tx, null);
      const del = await attempt(tx, `delete from public.expenses where id = $1`, [e]);
      return { wrongMirror, noReason, twice, edit, del };
    }, MFA);
    expect(r.wrongMirror).toMatch(/mirror the original/);
    expect(r.noReason).toMatch(/expenses_reversal_check/);
    expect(r.twice).toMatch(/reverses_expense_id_key|duplicate/);
    expect(r.edit).toMatch(/permission denied|append-only/);
    expect(r.del).toMatch(/append-only/);
  });
});

describe('financial periods', () => {
  it('a closed month accepts no payments; reopening needs a reason; only approvers close periods', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      await switchTo(tx, U.accountantA);
      const accountantClose = await attempt(tx, `insert into public.finance_periods (organization_id, period_month, changed_by) values ($1, '2026-09-01', $2)`, [ORG.A, U.accountantA]);
      await switchTo(tx, U.directorA);
      const period = (await one<{ id: string }>(tx, `insert into public.finance_periods (organization_id, period_month, changed_by) values ($1, '2026-09-01', $2) returning id`, [ORG.A, U.directorA])).id;
      await switchTo(tx, U.accountantA);
      const backdated = await attempt(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, received_at, created_by) values ($1, $2, $3, 'payment', 100.00, 'KGS', 'cash', '2026-09-15 12:00+06', $4)`, [ORG.A, BRANCH.A1, U.studentA1, U.accountantA]);
      const expense = await attempt(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, created_by) values ($1, $2, 'supplies', 10.00, '2026-09-30', 'Бумага', $3)`, [ORG.A, BRANCH.A1, U.accountantA]);
      const current = await attempt(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, created_by) values ($1, $2, $3, 'payment', 100.00, 'KGS', 'cash', $4)`, [ORG.A, BRANCH.A1, U.studentA1, U.accountantA]);
      await switchTo(tx, U.directorA);
      const reopenNoReason = await attempt(tx, `update public.finance_periods set status = 'open', changed_by = $2 where id = $1`, [period, U.directorA]);
      await tx.query(`update public.finance_periods set status = 'open', reason = 'Поздний банковский платёж', changed_by = $2 where id = $1`, [period, U.directorA]);
      await switchTo(tx, U.accountantA);
      const afterReopen = await attempt(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, received_at, created_by) values ($1, $2, $3, 'payment', 100.00, 'KGS', 'cash', '2026-09-15 12:00+06', $4)`, [ORG.A, BRANCH.A1, U.studentA1, U.accountantA]);
      return { accountantClose, backdated, expense, current, reopenNoReason, afterReopen, audit: await count(tx, `select 1 from public.audit_logs where entity = 'finance_periods'`) };
    }, MFA);
    expect(r.accountantClose).toMatch(/row-level security/);
    expect(r.backdated).toMatch(/financial period 2026-09 is closed/);
    expect(r.expense).toMatch(/financial period 2026-09 is closed/);
    expect(r.current).toBe('ok:1');
    expect(r.reopenNoReason).toMatch(/finance_periods_reopen_check/);
    expect(r.afterReopen).toBe('ok:1');
  });
});

describe('provider payments (webhook)', () => {
  const record = (tx: Tx, o: { event: string; ref: string; amount?: string; currency?: string; invoice?: string }) =>
    tx
      .query<{ r: { outcome: string; paymentId?: string; allocated?: string } }>('select public.record_provider_payment($1, $2, $3, $4, $5, $6, $7, now()) as r', [
        'test_psp', o.event, 'a'.repeat(64), o.invoice ?? INVOICE.A1, o.amount ?? '2000.00', o.currency ?? 'KGS', o.ref,
      ])
      .then((x) => x.rows[0]!.r);

  it('records once: a repeated event or the same provider operation returns the same payment', async () => {
    const r = await asService(db, async (tx) => {
      const first = await record(tx, { event: 'evt_1', ref: 'op_1' });
      const repeat = await record(tx, { event: 'evt_1', ref: 'op_1' });
      const sameOp = await record(tx, { event: 'evt_2', ref: 'op_1' });
      return {
        first,
        repeat,
        sameOp,
        payments: await count(tx, `select 1 from public.payments where provider = 'test_psp'`),
        paid: (await one<{ p: string }>(tx, 'select paid::text as p from public.invoice_balances where invoice_id = $1', [INVOICE.A1])).p,
        events: await rows(tx, `select event_id, outcome from public.payment_webhook_events order by received_at, event_id`),
      };
    });
    expect(r.first).toMatchObject({ outcome: 'recorded' });
    expect(r.repeat).toEqual({ outcome: 'duplicate', paymentId: r.first.paymentId });
    expect(r.sameOp).toEqual({ outcome: 'duplicate', paymentId: r.first.paymentId });
    expect(r.payments).toBe(1);
    expect(r.paid).toBe('2000.00');
  });

  it('validates amount and currency on the server; overpayment stays unallocated', async () => {
    const r = await asService(db, async (tx) => ({
      fraction: await record(tx, { event: 'e1', ref: 'o1', amount: '10.005' }),
      negative: await record(tx, { event: 'e2', ref: 'o2', amount: '-5' }),
      currency: await record(tx, { event: 'e3', ref: 'o3', currency: 'USD' }),
      draft: await record(tx, { event: 'e4', ref: 'o4', invoice: '00000000-0000-4000-8000-000000000999' }),
      over: await record(tx, { event: 'e5', ref: 'o5', amount: '6000.00' }),
      payments: await count(tx, `select 1 from public.payments where provider = 'test_psp'`),
    }));
    expect([r.fraction.outcome, r.negative.outcome, r.currency.outcome, r.draft.outcome]).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(r.over).toMatchObject({ outcome: 'recorded', allocated: 5000 });
    expect(r.payments).toBe(1);
  });

  it('only the server can record provider payments', async () => {
    await expectDenied(as(db, U.accountantA, (tx) => record(tx, { event: 'x', ref: 'y' }), MFA), /permission denied/);
    await expectDenied(as(db, U.accountantA, (tx) => tx.query('select * from public.payment_webhook_events'), MFA), /permission denied/);
  });
});

describe('reports reconcile with the operations', () => {
  it('per-branch totals equal the recorded test operations; scope follows finance.read', async () => {
    const r = await as(db, U.accountantA, async (tx) => {
      await switchTo(tx, U.accountantA);
      await tx.query(`insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, created_by) values ($1, $2, $3, $4, 3000.00, $5)`, [ORG.A, BRANCH.A1, PAYMENT.A1, INVOICE.A1, U.accountantA]);
      const pay = (await one<{ id: string }>(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, created_by) values ($1, $2, $3, 'payment', 1000.00, 'KGS', 'card', $4) returning id`, [ORG.A, BRANCH.A1, U.studentA1, U.accountantA])).id;
      await tx.query(`insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, reverses_payment_id, reason, created_by) values ($1, $2, $3, 'refund', 400.00, 'KGS', 'card', $4, 'Переплата', $5)`, [ORG.A, BRANCH.A1, U.studentA1, pay, U.accountantA]);
      await tx.query(`insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, created_by) values ($1, $2, 'rent', 1200.00, current_date, 'Аренда', $3)`, [ORG.A, BRANCH.A1, U.accountantA]);
      const wrong = (await one<{ id: string }>(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, created_by) values ($1, $2, 'other', 300.00, current_date, 'Ошибка', $3) returning id`, [ORG.A, BRANCH.A1, U.accountantA])).id;
      await tx.query(`insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, reverses_expense_id, reason, created_by) values ($1, $2, 'other', 300.00, current_date, 'Сторно', $3, 'ошибочная запись', $4)`, [ORG.A, BRANCH.A1, wrong, U.accountantA]);
      const report = async () => (await tx.query<{ r: Record<string, string>[] }>(`select public.finance_report($1, current_date - 1, current_date + 1) as r`, [ORG.A])).rows[0]!.r;
      const accountant = await report();
      await switchTo(tx, U.managerA1);
      const manager = await report();
      await switchTo(tx, U.adminA1);
      const admin = await report();
      await switchTo(tx, U.accountantA);
      const debts = (await tx.query<{ r: { payerId: string; outstanding: string }[] }>('select public.finance_debts($1) as r', [ORG.A])).rows[0]!.r;
      return { accountant, manager, admin, debts };
    }, MFA);
    const strip = (rows: Record<string, string>[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'branchId')));
    expect(strip(r.accountant)).toEqual([
      { branch: 'A1', currency: 'KGS', invoiced: '5000.00', received: '4000.00', refunded: '400.00', expenses: '1200.00', outstanding: '2000.00' },
      { branch: 'A2', currency: 'KGS', invoiced: '5000.00', received: '5000.00', refunded: '0.00', expenses: '0.00', outstanding: '5000.00' },
    ]);
    expect(strip(r.manager)).toEqual([strip(r.accountant)[0]]);
    expect(r.admin).toEqual([]);
    expect(r.debts.map((d) => [d.payerId, d.outstanding])).toEqual([
      [U.studentA2, '5000.00'],
      [U.studentA1, '2000.00'],
    ]);
  });
});

describe('separation of duties', () => {
  it('the director approves but does not record money; the accountant records but does not approve', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      await switchTo(tx, U.directorA);
      const directorPayment = await attempt(tx, `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, created_by) values ($1, $2, $3, 'payment', 1.00, 'KGS', 'cash', $4)`, [ORG.A, BRANCH.A1, U.studentA1, U.directorA]);
      const directorExpense = await attempt(tx, `insert into public.expenses (organization_id, branch_id, category, amount, spent_on, description, created_by) values ($1, $2, 'other', 1.00, current_date, 'x', $3)`, [ORG.A, BRANCH.A1, U.directorA]);
      await switchTo(tx, U.accountantA);
      const accountantPeriod = await attempt(tx, `insert into public.finance_periods (organization_id, period_month, changed_by) values ($1, '2026-08-01', $2)`, [ORG.A, U.accountantA]);
      await switchTo(tx, U.studentA1);
      const studentSeesExpenses = await count(tx, 'select 1 from public.expenses');
      return { directorPayment, directorExpense, accountantPeriod, studentSeesExpenses };
    }, MFA);
    expect(r.directorPayment).toMatch(/row-level security/);
    expect(r.directorExpense).toMatch(/row-level security/);
    expect(r.accountantPeriod).toMatch(/row-level security/);
    expect(r.studentSeesExpenses).toBe(0);
  });
});
