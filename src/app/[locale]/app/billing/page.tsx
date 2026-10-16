import { notFound } from 'next/navigation';
import { Badge, EmptyState, Notice } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatDate, formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { formatMoney } from '@/server/finance/constants';
import { createUserClient } from '@/server/supabase/server';

/** Оплата обучения для ученика и родителя: свои счета и платежи (RLS: плательщик и опекун). */
export default async function BillingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/billing`);
  const t = getDictionary(locale);
  const f = t.finance;
  const db = await createUserClient();
  const isPayerView = (id: string) => id === ctx.user.id;
  const [{ data: invoices }, { data: balances }, { data: payments }] = await Promise.all([
    db.from('invoices').select('id, number, status, currency, due_on, payer_id, description').neq('status', 'draft').order('created_at', { ascending: false }).limit(100),
    db.from('invoice_balances').select('invoice_id, due, paid, outstanding, payment_status'),
    db.from('payments').select('id, kind, amount, currency, method, received_at, payer_id, reason').order('received_at', { ascending: false }).limit(100),
  ]);
  // Сотруднику финансов RLS отдал бы и чужие счета — здесь только свои и подопечных.
  const { data: wards } = await db.from('guardian_links').select('student_id').eq('guardian_id', ctx.user.id).eq('status', 'active');
  const own = new Set([ctx.user.id, ...(wards ?? []).map((w) => w.student_id as string)]);
  const relevant = (payer: string) => own.has(payer);
  const ids = [...new Set((invoices ?? []).map((i) => i.payer_id as string))];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const balOf = (id: string) => (balances ?? []).find((b) => b.invoice_id === id);
  const myInvoices = (invoices ?? []).filter((i) => relevant(i.payer_id as string));
  const myPayments = (payments ?? []).filter((p) => relevant(p.payer_id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={f.billingTitle}>
      <section aria-labelledby="inv-h" className="space-y-3">
        <h2 id="inv-h" className="text-xl font-bold">
          {f.myInvoices}
        </h2>
        {myInvoices.length === 0 ? <EmptyState title={f.noInvoices} /> : null}
        <ul className="space-y-2">
          {myInvoices.map((i) => {
            const b = balOf(i.id as string);
            return (
              <li key={i.id as string} className="space-y-1 rounded-[var(--radius-control)] border border-border px-3 py-2">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {f.invoice} {i.number as string}
                    {!isPayerView(i.payer_id as string) ? ` · ${nameOf(i.payer_id as string)}` : ''}
                    {i.due_on ? ` · ${f.dueOn}: ${formatDate(locale, i.due_on as string)}` : ''}
                  </span>
                  <Badge tone={b?.payment_status === 'paid' ? 'success' : i.status === 'void' ? 'neutral' : 'warning'}>{f.paymentStatuses[(b?.payment_status ?? i.status) as 'paid']}</Badge>
                </p>
                {b ? (
                  <p className="text-sm tabular-nums">
                    {f.due}: {formatMoney(b.due as string, i.currency as string)} · {f.paid}: {formatMoney(b.paid as string, i.currency as string)} · <strong>{f.outstanding}: {formatMoney(b.outstanding as string, i.currency as string)}</strong>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <Notice tone="info">{f.payOnline}</Notice>
      </section>
      <section aria-labelledby="pay-h" className="space-y-3">
        <h2 id="pay-h" className="text-xl font-bold">
          {f.myPayments}
        </h2>
        {myPayments.length === 0 ? <p className="text-muted">{f.noPayments}</p> : null}
        <ul className="space-y-1">
          {myPayments.map((p) => (
            <li key={p.id as string} className="flex flex-wrap justify-between gap-2 border-b border-border py-1">
              <span>
                {formatShortDateTime(locale, p.received_at as string, DEFAULT_TIMEZONE)} · {f.methods[p.method as 'cash']}
                {p.kind === 'refund' ? ` · ${f.refund}: ${p.reason as string}` : ''}
              </span>
              <strong className="tabular-nums">
                {p.kind === 'refund' ? '−' : ''}
                {formatMoney(p.amount as string, p.currency as string)}
              </strong>
            </li>
          ))}
        </ul>
      </section>
    </WorkspacePage>
  );
}
