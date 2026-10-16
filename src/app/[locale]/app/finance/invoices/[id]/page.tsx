import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { FinanceTabs } from '@/features/finance/finance-tabs';
import { formatDate, formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import {
  addLineAction,
  allocateAction,
  decideAdjustmentAction,
  issueInvoiceAction,
  releaseAction,
  removeLineAction,
  requestAdjustmentAction,
  voidInvoiceAction,
} from '@/server/finance/actions';
import { addMoney, compareMoney, formatMoney, subMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { createUserClient } from '@/server/supabase/server';

export default async function InvoicePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance/invoices/${id}`);
  const t = getDictionary(locale);
  const f = t.finance;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const db = await createUserClient();
  const { data: inv } = await db.from('invoices').select('*').eq('id', id).maybeSingle();
  if (!inv) notFound();
  const org = inv.organization_id as string;
  const branch = inv.branch_id as string;
  const cur = inv.currency as string;
  const draft = inv.status === 'draft';
  const issued = inv.status === 'issued';
  const canWrite = scope.branchCan('finance.write', org, branch);
  const canRefund = scope.branchCan('finance.refund', org, branch);
  const canApprove = scope.branchCan('finance.approve', org, branch);

  const [{ data: bal }, { data: lines }, { data: adjustments }, { data: allocations }, { data: history }, { data: tariffs }, { data: payments }] = await Promise.all([
    db.from('invoice_balances').select('due, paid, outstanding, payment_status').eq('invoice_id', id).maybeSingle(),
    db.from('invoice_lines').select('id, description, quantity, unit_price, line_total, tariff_id').eq('invoice_id', id).order('created_at'),
    db.from('invoice_adjustments').select('id, kind, amount, reason, status, requested_by, decided_by, decision_note').eq('invoice_id', id).order('created_at'),
    db.from('payment_allocations').select('id, payment_id, amount, kind, reverses_allocation_id, reason, created_at').eq('invoice_id', id).order('created_at'),
    db.from('invoice_status_history').select('id, from_status, to_status, reason, actor_id, created_at').eq('invoice_id', id).order('id'),
    draft && canWrite
      ? db.from('tariffs').select('id, name, amount, unit, price_lists!inner(status, currency, branch_id)').eq('organization_id', org).eq('status', 'active')
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    issued && canWrite
      ? db.from('payments').select('id, amount, received_at, kind').eq('payer_id', inv.payer_id as string).eq('kind', 'payment').eq('currency', cur)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  // Свободный остаток платежей плательщика: сумма − распределено (нетто) − возвращено.
  const paymentIds = (payments ?? []).map((p) => p.id as string);
  const [{ data: payAllocs }, { data: payRefunds }] = paymentIds.length
    ? await Promise.all([
        db.from('payment_allocations').select('payment_id, amount, kind').in('payment_id', paymentIds),
        db.from('payments').select('reverses_payment_id, amount').in('reverses_payment_id', paymentIds),
      ])
    : [{ data: [] }, { data: [] }];
  const freeOf = (pid: string, amount: string) => {
    const used = (payAllocs ?? []).filter((a) => a.payment_id === pid).map((a) => (a.kind === 'allocate' ? String(a.amount) : `-${String(a.amount)}`));
    const refunded = (payRefunds ?? []).filter((r) => r.reverses_payment_id === pid).map((r) => String(r.amount));
    return subMoney(amount, addMoney(...used, ...refunded));
  };
  const usable = (payments ?? []).map((p) => ({ id: p.id as string, free: freeOf(p.id as string, String(p.amount)), at: p.received_at as string })).filter((p) => compareMoney(p.free, '0') > 0);
  const releasedOf = (aid: string) => addMoney(...(allocations ?? []).filter((a) => a.reverses_allocation_id === aid).map((a) => String(a.amount)));
  const people = [...new Set([inv.payer_id as string, ...(adjustments ?? []).flatMap((a) => [a.requested_by as string, a.decided_by as string]), ...(history ?? []).map((h) => h.actor_id as string)].filter(Boolean))];
  const { data: names } = people.length ? await db.from('profiles').select('id, full_name').in('id', people) : { data: [] };
  const nameOf = (pid: string | null) => (pid ? ((names ?? []).find((p) => p.id === pid)?.full_name as string) || '—' : '—');
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="invoiceId" value={id} />
      <input type="hidden" name="organizationId" value={org} />
      <input type="hidden" name="branchId" value={branch} />
    </>
  );
  const availableTariffs = (tariffs ?? []).filter((tf) => {
    const pl = (Array.isArray(tf.price_lists) ? tf.price_lists[0] : tf.price_lists) as { status: string; currency: string; branch_id: string | null } | undefined;
    return pl && pl.status === 'active' && pl.currency === cur && (pl.branch_id === null || pl.branch_id === branch);
  });

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${f.invoice} ${inv.number as string}`} allowed={scope.canRead || inv.payer_id === ctx.user.id}>
      {scope.canRead ? <FinanceTabs locale={locale} t={t} current="invoices" /> : null}
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="font-semibold">{f.payer}</dt>
        <dd>{nameOf(inv.payer_id as string)}</dd>
        <dt className="font-semibold">{f.status}</dt>
        <dd>
          <Badge tone={bal?.payment_status === 'paid' ? 'success' : inv.status === 'void' ? 'warning' : 'neutral'}>{f.paymentStatuses[(bal?.payment_status ?? inv.status) as 'paid']}</Badge>
          {inv.void_reason ? ` · ${inv.void_reason as string}` : ''}
        </dd>
        {inv.due_on ? (
          <>
            <dt className="font-semibold">{f.dueOn}</dt>
            <dd>{formatDate(locale, inv.due_on as string)}</dd>
          </>
        ) : null}
        <dt className="font-semibold">{f.total}</dt>
        <dd className="tabular-nums">{formatMoney(inv.total as string, cur)}</dd>
        {bal ? (
          <>
            <dt className="font-semibold">{f.due}</dt>
            <dd className="tabular-nums">{formatMoney(bal.due as string, cur)}</dd>
            <dt className="font-semibold">{f.paid}</dt>
            <dd className="tabular-nums">{formatMoney(bal.paid as string, cur)}</dd>
            <dt className="font-semibold">{f.outstanding}</dt>
            <dd className="tabular-nums font-bold">{formatMoney(bal.outstanding as string, cur)}</dd>
          </>
        ) : null}
      </dl>

      <section aria-labelledby="lines-h" className="space-y-3">
        <h2 id="lines-h" className="text-xl font-bold">
          {f.lines}
        </h2>
        <ul className="space-y-1">
          {(lines ?? []).map((l) => (
            <li key={l.id as string} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1">
              <span>
                {l.description as string} · {String(l.quantity)} × {formatMoney(l.unit_price as string, cur)}
              </span>
              <span className="flex items-center gap-2">
                <strong className="tabular-nums">{formatMoney(l.line_total as string, cur)}</strong>
                {draft && canWrite ? (
                  <ActionForm action={removeLineAction} submitLabel={f.remove} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="lineId" value={l.id as string} />
                  </ActionForm>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {draft && canWrite ? (
          <ActionForm action={addLineAction} submitLabel={f.addLine} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ quantity: f.quantity, unitPrice: f.unitPrice, description: f.description }} className="grid gap-3 sm:grid-cols-4">
            {hidden}
            <SelectField name="tariffId" label={f.tariff} idPrefix="ln">
              {availableTariffs.map((tf) => (
                <option key={tf.id as string} value={tf.id as string}>
                  {tf.name as string} — {formatMoney(tf.amount as string, cur)} / {f.units[tf.unit as 'month']}
                </option>
              ))}
              <option value="">{f.noTariff}</option>
            </SelectField>
            <Field name="description" label={f.description} required maxLength={300} idPrefix="ln" />
            <Field name="quantity" label={f.quantity} required inputMode="decimal" defaultValue="1" idPrefix="ln" />
            <Field name="unitPrice" label={f.unitPrice} inputMode="decimal" idPrefix="ln" />
          </ActionForm>
        ) : null}
      </section>

      <section aria-labelledby="adj-h" className="space-y-3">
        <h2 id="adj-h" className="text-xl font-bold">
          {f.adjustments}
        </h2>
        <p className="text-sm text-muted">{f.fourEyes}</p>
        <ul className="space-y-2">
          {(adjustments ?? []).map((a) => (
            <li key={a.id as string} className="space-y-1 rounded-[var(--radius-control)] border border-border p-3">
              <p className="flex flex-wrap items-center gap-2">
                <Badge>{f.kinds[a.kind as 'discount']}</Badge>
                <strong className="tabular-nums">{formatMoney(a.amount as string, cur)}</strong>
                <Badge tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'warning' : 'neutral'}>{f.adjustmentStatuses[a.status as 'pending']}</Badge>
              </p>
              <p className="text-sm">
                {a.reason as string} · {f.requestedBy}: {nameOf(a.requested_by as string)}
                {a.decided_by ? ` · ${f.decidedBy}: ${nameOf(a.decided_by as string)}` : ''}
              </p>
              {a.status === 'pending' && canApprove && a.requested_by !== ctx.user.id ? (
                <div className="flex flex-wrap gap-2">
                  {(['approved', 'rejected'] as const).map((d) => (
                    <ActionForm key={d} action={decideAdjustmentAction} submitLabel={d === 'approved' ? f.approve : f.reject} pendingLabel={t.common.pending} messages={msg} variant={d === 'approved' ? 'primary' : 'secondary'}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="adjustmentId" value={a.id as string} />
                      <input type="hidden" name="decision" value={d} />
                    </ActionForm>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite && (draft || issued) ? (
          <ActionForm action={requestAdjustmentAction} submitLabel={f.requestAdjustment} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: f.amount, reason: f.reason }} className="grid gap-3 sm:grid-cols-3">
            {hidden}
            <SelectField name="kind" label={f.kind} idPrefix="adj">
              {(draft ? (['discount'] as const) : (['credit', 'debit'] as const)).map((k) => (
                <option key={k} value={k}>
                  {f.kinds[k]}
                </option>
              ))}
            </SelectField>
            <Field name="amount" label={f.amount} required inputMode="decimal" idPrefix="adj" />
            <Field name="reason" label={f.reason} required minLength={3} maxLength={500} idPrefix="adj" />
          </ActionForm>
        ) : null}
      </section>

      {canWrite && draft ? (
        <ActionForm action={issueInvoiceAction} submitLabel={f.issue} pendingLabel={t.common.pending} messages={msg}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="invoiceId" value={id} />
        </ActionForm>
      ) : null}

      {issued ? (
        <section aria-labelledby="alloc-h" className="space-y-3">
          <h2 id="alloc-h" className="text-xl font-bold">
            {f.allocations}
          </h2>
          <ul className="space-y-2">
            {(allocations ?? [])
              .filter((a) => a.kind === 'allocate')
              .map((a) => {
                const released = releasedOf(a.id as string);
                const left = subMoney(String(a.amount), released);
                return (
                  <li key={a.id as string} className="flex flex-wrap items-center gap-3">
                    <span className="tabular-nums">
                      {formatShortDateTime(locale, a.created_at as string, DEFAULT_TIMEZONE)} · {formatMoney(a.amount as string, cur)}
                      {compareMoney(released, '0') > 0 ? ` (${f.released} ${formatMoney(released, cur)})` : ''}
                    </span>
                    {canRefund && compareMoney(left, '0') > 0 ? (
                      <ActionForm action={releaseAction} submitLabel={f.release} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: f.amount, reason: f.releaseReason }} variant="secondary" className="flex flex-wrap items-end gap-2">
                        {hidden}
                        <input type="hidden" name="allocationId" value={a.id as string} />
                        <input type="hidden" name="paymentId" value={a.payment_id as string} />
                        <Field name="amount" label={f.amount} required inputMode="decimal" defaultValue={left} idPrefix={`rel-${a.id as string}`} />
                        <Field name="reason" label={f.releaseReason} required minLength={3} maxLength={500} idPrefix={`rel-${a.id as string}`} />
                      </ActionForm>
                    ) : null}
                  </li>
                );
              })}
          </ul>
          {canWrite && usable.length && bal && compareMoney(String(bal.outstanding), '0') > 0 ? (
            <ActionForm action={allocateAction} submitLabel={f.allocate} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: f.amount }} className="flex flex-wrap items-end gap-3">
              {hidden}
              <SelectField name="paymentId" label={f.payment} idPrefix="al">
                {usable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {formatShortDateTime(locale, p.at, DEFAULT_TIMEZONE)} — {fmt(f.free, { amount: formatMoney(p.free, cur) })}
                  </option>
                ))}
              </SelectField>
              <Field name="amount" label={f.amount} required inputMode="decimal" defaultValue={String(bal.outstanding)} idPrefix="al" />
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {canWrite && issued && bal && compareMoney(String(bal.paid), '0') === 0 ? (
        <Card className="space-y-2">
          <ActionForm
            action={voidInvoiceAction}
            submitLabel={f.voidInvoice}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ reason: f.voidReason }}
            variant="danger"
            confirm={{ title: f.voidConfirmTitle, text: f.voidConfirmText, confirmLabel: f.voidInvoice, cancelLabel: f.keep }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="invoiceId" value={id} />
            <Field name="reason" label={f.voidReason} required minLength={3} maxLength={500} idPrefix="void" />
          </ActionForm>
        </Card>
      ) : null}

      <section aria-labelledby="hist-h" className="space-y-2">
        <h2 id="hist-h" className="text-xl font-bold">
          {f.history}
        </h2>
        <ol className="space-y-1 text-sm">
          {(history ?? []).map((h) => (
            <li key={String(h.id)}>
              {formatShortDateTime(locale, h.created_at as string, DEFAULT_TIMEZONE)} · {h.from_status ? `${f.invoiceStatuses[h.from_status as 'draft']} → ` : ''}
              {f.invoiceStatuses[h.to_status as 'draft']} · {nameOf(h.actor_id as string | null)}
              {h.reason ? ` · ${h.reason as string}` : ''}
            </li>
          ))}
        </ol>
      </section>
      <p>
        <Link className="link" href={`/${locale}/app/finance/invoices`}>
          {f.invoices}
        </Link>
      </p>
    </WorkspacePage>
  );
}
