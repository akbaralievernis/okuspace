import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { FinanceTabs } from '@/features/finance/finance-tabs';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { recordPaymentAction, refundAction } from '@/server/finance/actions';
import { METHODS, addMoney, compareMoney, formatMoney, subMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { createUserClient } from '@/server/supabase/server';

export default async function PaymentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance/payments`);
  const t = getDictionary(locale);
  const f = t.finance;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const org = scope.orgs[0];
  const db = await createUserClient();
  const [{ data: payments }, { data: allocs }, { data: branches }, { data: students }, { data: openInvoices }] = await Promise.all([
    scope.canRead
      ? db.from('payments').select('id, organization_id, branch_id, payer_id, kind, amount, currency, method, reverses_payment_id, reason, source, received_at').order('received_at', { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    scope.canRead ? db.from('payment_allocations').select('payment_id, amount, kind') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    org ? db.from('branches').select('id, name').eq('organization_id', org).order('name') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    org && scope.canWrite ? db.from('memberships').select('profile_id').eq('organization_id', org).eq('role', 'student').eq('status', 'active') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    org && scope.canWrite ? db.from('invoice_balances').select('invoice_id, payer_id, outstanding, status').eq('status', 'issued').gt('outstanding', 0) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const ids = [...new Set([...(payments ?? []).map((p) => p.payer_id as string), ...(students ?? []).map((s) => s.profile_id as string)])];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const { data: invNumbers } = (openInvoices ?? []).length ? await db.from('invoices').select('id, number').in('id', (openInvoices ?? []).map((i) => i.invoice_id as string)) : { data: [] };
  const usedOf = (pid: string) =>
    addMoney(
      ...(allocs ?? []).filter((a) => a.payment_id === pid).map((a) => (a.kind === 'allocate' ? String(a.amount) : `-${String(a.amount)}`)),
      ...(payments ?? []).filter((r) => r.reverses_payment_id === pid).map((r) => String(r.amount)),
    );
  const writable = (branches ?? []).filter((b) => scope.branchCan('finance.write', org!, b.id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={f.payments} allowed={scope.canRead}>
      <FinanceTabs locale={locale} t={t} current="payments" />
      {(payments ?? []).length === 0 ? <EmptyState title={f.empty} /> : null}
      <ul className="space-y-2">
        {(payments ?? []).map((p) => {
          const refund = p.kind === 'refund';
          const used = refund ? '0' : usedOf(p.id as string);
          const free = subMoney(String(p.amount), used);
          return (
            <li key={p.id as string} className="space-y-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {formatShortDateTime(locale, p.received_at as string, DEFAULT_TIMEZONE)} · {nameOf(p.payer_id as string)} · {f.methods[p.method as 'cash']} · {f.sources[p.source as 'staff']}
                </span>
                <span className="flex items-center gap-2">
                  {refund ? <Badge tone="warning">{f.refund}</Badge> : null}
                  <strong className="tabular-nums">
                    {refund ? '−' : ''}
                    {formatMoney(p.amount as string, p.currency as string)}
                  </strong>
                </span>
              </p>
              {refund ? <p className="text-sm text-muted">{p.reason as string}</p> : <p className="text-sm text-muted">{fmt(f.used, { amount: formatMoney(used, p.currency as string) })} · {fmt(f.free, { amount: formatMoney(free, p.currency as string) })}</p>}
              {!refund && compareMoney(free, '0') > 0 && scope.branchCan('finance.refund', p.organization_id as string, p.branch_id as string) ? (
                <ActionForm action={refundAction} submitLabel={f.refund} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: f.amount, reason: f.refundReason }} variant="secondary" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="paymentId" value={p.id as string} />
                  <Field name="amount" label={f.amount} required inputMode="decimal" defaultValue={free} idPrefix={`rf-${p.id as string}`} />
                  <Field name="reason" label={f.refundReason} required minLength={3} maxLength={500} idPrefix={`rf-${p.id as string}`} />
                </ActionForm>
              ) : null}
            </li>
          );
        })}
      </ul>

      {scope.canWrite && writable.length ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{f.recordPayment}</h2>
          <ActionForm action={recordPaymentAction} submitLabel={f.recordPayment} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: f.amount, receivedAt: f.receivedAt }} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org!} />
            <input type="hidden" name="currency" value="KGS" />
            <input type="hidden" name="timezone" value={DEFAULT_TIMEZONE} />
            <SelectField name="branchId" label={f.branch} idPrefix="np">
              {writable.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
            </SelectField>
            <SelectField name="payerId" label={f.payer} idPrefix="np">
              {[...new Set((students ?? []).map((s) => s.profile_id as string))].map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </SelectField>
            <Field name="amount" label={f.amount} required inputMode="decimal" idPrefix="np" />
            <SelectField name="method" label={f.method} idPrefix="np">
              {METHODS.filter((x) => x !== 'online').map((x) => (
                <option key={x} value={x}>
                  {f.methods[x]}
                </option>
              ))}
            </SelectField>
            <Field name="receivedAt" label={f.receivedAt} type="datetime-local" idPrefix="np" />
            <SelectField name="invoiceId" label={f.invoice} idPrefix="np">
              <option value="">{f.noInvoice}</option>
              {(openInvoices ?? []).map((i) => (
                <option key={i.invoice_id as string} value={i.invoice_id as string}>
                  {((invNumbers ?? []).find((n) => n.id === i.invoice_id)?.number as string) ?? '—'} · {nameOf(i.payer_id as string)} · {formatMoney(i.outstanding as string)}
                </option>
              ))}
            </SelectField>
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}
