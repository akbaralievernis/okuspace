import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, INVOICE, ORG, PAYMENT, U, createSeededDb } from '../db/fixtures';
import { as, asService, count, rows, type Tx } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const MFA = { aal: 'aal2' } as const;

const insertPayment = (tx: Tx, actor: string, values: { amount: string; kind?: string; reverses?: string; reason?: string; ref?: string }) =>
  tx.query(
    `insert into public.payments (organization_id, branch_id, payer_id, kind, amount, currency, method, reverses_payment_id, reason, provider, provider_ref, created_by)
     values ($1, $2, $3, $4, $5::numeric, 'KGS', 'online', $6, $7, $8, $9, $10)`,
    [
      ORG.A, BRANCH.A1, U.studentA1, values.kind ?? 'payment', values.amount, values.reverses ?? null, values.reason ?? null,
      values.ref ? 'test_psp' : null, values.ref ?? null, actor,
    ],
  );

const allocate = (tx: Tx, actor: string, amount: string, payment: string = PAYMENT.A1, invoice: string = INVOICE.A1) =>
  tx.query(
    `insert into public.payment_allocations (organization_id, branch_id, payment_id, invoice_id, amount, created_by)
     values ($1, $2, $3, $4, $5::numeric, $6)`,
    [ORG.A, BRANCH.A1, payment, invoice, amount, actor],
  );

describe('visibility (чужая оплата)', () => {
  const visiblePayments = (userId: string) =>
    as(db, userId, async (tx) => (await rows<{ id: string }>(tx, 'select id from public.payments')).map((r) => r.id).sort());

  it('payers see their own payments; guardians see their child’s', async () => {
    expect(await visiblePayments(U.studentA1)).toEqual([PAYMENT.A1]);
    expect(await visiblePayments(U.parentA1)).toEqual([PAYMENT.A1]);
    expect(await visiblePayments(U.studentA1b)).toEqual([]);
  });

  it('teachers, admins and sales managers see no payments', async () => {
    for (const actor of [U.teacherA1, U.adminA1, U.salesA1]) expect(await visiblePayments(actor), actor).toEqual([]);
  });

  it('finance staff see payments in their scope only', async () => {
    expect(await visiblePayments(U.accountantA)).toEqual([PAYMENT.A1, PAYMENT.A2].sort());
    expect(await visiblePayments(U.managerA1)).toEqual([PAYMENT.A1]);
    expect(await visiblePayments(U.accountantB)).toEqual([PAYMENT.B]);
  });
});

describe('writing money (разделение прав бухгалтера и руководителя)', () => {
  it('requires MFA (aal2) even for an accountant', async () => {
    await expectDenied(as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '100.00' })));
    await expect(as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '100.00' }), MFA)).resolves.toBeDefined();
  });

  it('directors and branch managers can read but not record payments', async () => {
    for (const actor of [U.directorA, U.managerA1]) {
      await expectDenied(as(db, actor, (tx) => insertPayment(tx, actor, { amount: '100.00' }), MFA));
    }
  });

  it('students cannot record payments for themselves', async () => {
    await expectDenied(as(db, U.studentA1, (tx) => insertPayment(tx, U.studentA1, { amount: '100.00' }), MFA));
  });

  it('created_by cannot be forged', async () => {
    await expectDenied(as(db, U.accountantA, (tx) => insertPayment(tx, U.directorA, { amount: '100.00' }), MFA));
  });

  it('amounts must be positive and keep exact decimals', async () => {
    await expectDenied(as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '-5.00' }), MFA), /check constraint/);
    const stored = await as(
      db,
      U.accountantA,
      async (tx) => {
        await insertPayment(tx, U.accountantA, { amount: '0.10', ref: 'decimals-1' });
        await insertPayment(tx, U.accountantA, { amount: '0.20', ref: 'decimals-2' });
        return rows<{ s: string }>(tx, `select sum(amount)::text as s from public.payments where provider_ref like 'decimals-%'`);
      },
      MFA,
    );
    expect(stored[0]?.s).toBe('0.30'); // float дал бы 0.30000000000000004
  });
});

describe('idempotency and append-only', () => {
  it('a repeated provider event cannot create a second payment', async () => {
    await expectDenied(
      as(
        db,
        U.accountantA,
        async (tx) => {
          await insertPayment(tx, U.accountantA, { amount: '500.00', ref: 'evt_123' });
          await insertPayment(tx, U.accountantA, { amount: '500.00', ref: 'evt_123' });
        },
        MFA,
      ),
      /payments_provider_ref_key/,
    );
  });

  it('payments and allocations cannot be updated or deleted, even by the service role', async () => {
    await expectDenied(asService(db, (tx) => tx.query(`update public.payments set amount = 1 where id = $1`, [PAYMENT.A1])), /append-only/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.payments where id = $1`, [PAYMENT.A1])), /append-only/);
    await expectDenied(asService(db, (tx) => tx.query('truncate public.payment_allocations')), /append-only/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.invoices where id = $1`, [INVOICE.A1])), /append-only/);
  });

  it('every payment is written to the audit log', async () => {
    const n = await as(
      db,
      U.accountantA,
      async (tx) => {
        await insertPayment(tx, U.accountantA, { amount: '700.00' });
        await tx.exec('reset role');
        return count(tx, `select 1 from public.audit_logs where entity = 'payments' and actor_id = $1`, [U.accountantA]);
      },
      MFA,
    );
    expect(n).toBe(1);
  });
});

describe('refunds and allocations', () => {
  it('a refund needs finance.refund, a reason and a link to the original', async () => {
    await expectDenied(
      as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '100.00', kind: 'refund', reverses: PAYMENT.A1 }), MFA),
      /payments_refund_reason_check/,
    );
    await expectDenied(
      as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '100.00', kind: 'refund', reason: 'x' }), MFA),
      /payments_refund_link_check/,
    );
    await expect(
      as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '100.00', kind: 'refund', reverses: PAYMENT.A1, reason: 'Отмена занятия' }), MFA),
    ).resolves.toBeDefined();
  });

  it('total refunds cannot exceed the original payment', async () => {
    await expectDenied(
      as(
        db,
        U.accountantA,
        async (tx) => {
          await insertPayment(tx, U.accountantA, { amount: '2000.00', kind: 'refund', reverses: PAYMENT.A1, reason: 'part 1' });
          await insertPayment(tx, U.accountantA, { amount: '1000.01', kind: 'refund', reverses: PAYMENT.A1, reason: 'part 2' });
        },
        MFA,
      ),
      /refund exceeds/,
    );
  });

  it('a refund cannot target another payer’s payment', async () => {
    await expectDenied(
      as(db, U.accountantA, (tx) => insertPayment(tx, U.accountantA, { amount: '10.00', kind: 'refund', reverses: PAYMENT.A2, reason: 'x' }), MFA),
      /same payer/,
    );
  });

  it('allocations cannot exceed the payment or the invoice', async () => {
    await expectDenied(as(db, U.accountantA, (tx) => allocate(tx, U.accountantA, '3000.01'), MFA), /exceeds the available payment/);
    await expectDenied(
      as(
        db,
        U.accountantA,
        async (tx) => {
          await allocate(tx, U.accountantA, '3000.00');
          await insertPayment(tx, U.accountantA, { amount: '5000.00', ref: 'second' });
          const second = await rows<{ id: string }>(tx, `select id from public.payments where provider_ref = 'second'`);
          await allocate(tx, U.accountantA, '2000.01', second[0]!.id);
        },
        MFA,
      ),
      /exceeds the invoice total/,
    );
  });

  it('allocated money cannot also be refunded (no double counting)', async () => {
    await expectDenied(
      as(
        db,
        U.accountantA,
        async (tx) => {
          await allocate(tx, U.accountantA, '2500.00');
          await insertPayment(tx, U.accountantA, { amount: '600.00', kind: 'refund', reverses: PAYMENT.A1, reason: 'x' });
        },
        MFA,
      ),
      /refund exceeds/,
    );
  });

  it('balances are derived from allocations', async () => {
    const balance = await as(
      db,
      U.accountantA,
      async (tx) => {
        await allocate(tx, U.accountantA, '3000.00');
        return rows<{ paid: string; outstanding: string; payment_status: string }>(
          tx,
          'select paid::text, outstanding::text, payment_status from public.invoice_balances where invoice_id = $1',
          [INVOICE.A1],
        );
      },
      MFA,
    );
    expect(balance[0]).toEqual({ paid: '3000.00', outstanding: '2000.00', payment_status: 'partially_paid' });
  });

  it('the payer sees their balance; other students do not', async () => {
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.invoice_balances'))).toBe(1);
    expect(await as(db, U.studentA1b, (tx) => count(tx, 'select 1 from public.invoice_balances'))).toBe(0);
  });
});

describe('invoices', () => {
  it('an issued invoice cannot be edited, only voided with a reason', async () => {
    await expectDenied(
      as(db, U.accountantA, (tx) => tx.query(`update public.invoices set total = 1 where id = $1`, [INVOICE.A1]), MFA),
      /can only be voided/,
    );
    await expectDenied(
      as(db, U.accountantA, (tx) => tx.query(`update public.invoices set status = 'void' where id = $1`, [INVOICE.A1]), MFA),
      /invoices_void_check/,
    );
    const voided = await as(
      db,
      U.accountantA,
      (tx) => tx.query(`update public.invoices set status = 'void', void_reason = 'duplicate' where id = $1`, [INVOICE.A1]),
      MFA,
    );
    expect(voided.affectedRows).toBe(1);
  });

  it('invoice numbers are unique per organization', async () => {
    await expectDenied(
      as(
        db,
        U.accountantA,
        (tx) =>
          tx.query(
            `insert into public.invoices (organization_id, branch_id, payer_id, number, total, created_by) values ($1, $2, $3, 'A-0001', 10, $4)`,
            [ORG.A, BRANCH.A1, U.studentA1, U.accountantA],
          ),
        MFA,
      ),
      /invoices_number_key/,
    );
  });

  it('cannot bill someone outside the organization', async () => {
    await expectDenied(
      as(
        db,
        U.accountantA,
        (tx) =>
          tx.query(
            `insert into public.invoices (organization_id, branch_id, payer_id, number, total, created_by) values ($1, $2, $3, 'A-0099', 10, $4)`,
            [ORG.A, BRANCH.A1, U.studentB, U.accountantA],
          ),
        MFA,
      ),
      /not a member/,
    );
  });
});
