import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { FinanceTabs } from '@/features/finance/finance-tabs';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { closePeriodAction, decideAdjustmentAction, reopenPeriodAction } from '@/server/finance/actions';
import { addMoney as add, compareMoney, formatMoney, subMoney as sub } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { localDate } from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

type ReportRow = { branchId: string; branch: string; currency: string; invoiced: string; received: string; refunded: string; expenses: string; outstanding: string };
type Debt = { payerId: string; payer: string | null; branch: string; currency: string; invoices: number; outstanding: string; oldestDueOn: string | null };

export default async function FinancePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ month?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance`);
  const t = getDictionary(locale);
  const f = t.finance;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const sp = await searchParams;
  const today = localDate(new Date(), DEFAULT_TIMEZONE);
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : today.slice(0, 7);
  const from = `${month}-01`;
  const [y, mo] = month.split('-').map(Number);
  const to = new Date(Date.UTC(y!, mo!, 0)).toISOString().slice(0, 10);
  const org = scope.orgs[0];
  const db = await createUserClient();

  const [report, debts, pending, periods] = org
    ? await Promise.all([
        db.rpc('finance_report', { p_org: org, p_from: from, p_to: to }),
        db.rpc('finance_debts', { p_org: org }),
        scope.canApprove
          ? db.from('invoice_adjustments').select('id, kind, amount, reason, requested_by, invoices(number, currency)').eq('status', 'pending').order('created_at')
          : Promise.resolve({ data: [] as Record<string, unknown>[] }),
        db.from('finance_periods').select('id, period_month, status, reason').eq('organization_id', org).order('period_month', { ascending: false }).limit(12),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const rows = ((report.data ?? []) as ReportRow[]).filter((r) => [r.invoiced, r.received, r.refunded, r.expenses, r.outstanding].some((v) => compareMoney(v, '0') !== 0));
  const requesterIds = [...new Set((pending.data ?? []).map((p) => p.requested_by as string))];
  const { data: names } = requesterIds.length ? await db.from('profiles').select('id, full_name').in('id', requesterIds) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const totals = rows.reduce(
    (acc, r) => ({ invoiced: add(acc.invoiced, r.invoiced), received: add(acc.received, r.received), refunded: add(acc.refunded, r.refunded), expenses: add(acc.expenses, r.expenses), outstanding: add(acc.outstanding, r.outstanding) }),
    { invoiced: '0', received: '0', refunded: '0', expenses: '0', outstanding: '0' },
  );
  const currency = rows[0]?.currency ?? 'KGS';

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={f.title} allowed={scope.canRead}>
      <FinanceTabs locale={locale} t={t} current="overview" />

      <section aria-labelledby="rep-h" className="space-y-3">
        <h2 id="rep-h" className="text-xl font-bold">
          {f.reportTitle}
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field name="month" label={f.month} type="month" defaultValue={month} idPrefix="rp" />
          <button type="submit" className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-4 hover:bg-surface-muted">
            {f.show}
          </button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title={f.empty} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">{f.reportTitle}</caption>
              <thead>
                <tr className="border-b border-border text-left">
                  {[f.branch, f.invoiced, f.received, f.refunded, f.netIncome, f.expensesCol, f.result, f.outstanding].map((h) => (
                    <th key={h} scope="col" className="px-2 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...rows.map((r) => ({ label: r.branch, ...r })), { label: f.total, currency, ...totals }].map((r) => {
                  const net = sub(r.received, r.refunded);
                  return (
                    <tr key={r.label} className="border-b border-border">
                      <th scope="row" className="px-2 py-2 text-left">
                        {r.label}
                      </th>
                      {[r.invoiced, r.received, r.refunded, net, r.expenses, sub(net, r.expenses), r.outstanding].map((v, i) => (
                        <td key={i} className="px-2 py-2 text-right tabular-nums">
                          {formatMoney(v, r.currency)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="debt-h" className="space-y-3">
        <h2 id="debt-h" className="text-xl font-bold">
          {f.debtsTitle}
        </h2>
        {((debts.data ?? []) as Debt[]).length === 0 ? <p className="text-muted">{f.noDebts}</p> : null}
        <ul className="space-y-1">
          {((debts.data ?? []) as Debt[]).slice(0, 50).map((d) => (
            <li key={`${d.payerId}-${d.branch}-${d.currency}`} className="flex flex-wrap justify-between gap-2 border-b border-border py-1">
              <span>
                {d.payer ?? '—'} · {d.branch} · {f.invoicesCount}: {d.invoices}
                {d.oldestDueOn ? ` · ${f.oldestDue}: ${formatDate(locale, d.oldestDueOn)}` : ''}
              </span>
              <strong className="tabular-nums">{formatMoney(d.outstanding, d.currency)}</strong>
            </li>
          ))}
        </ul>
      </section>

      {scope.canApprove ? (
        <section aria-labelledby="appr-h" className="space-y-3">
          <h2 id="appr-h" className="text-xl font-bold">
            {f.approvalsTitle}
          </h2>
          <p className="text-sm text-muted">{f.fourEyes}</p>
          {(pending.data ?? []).length === 0 ? <p className="text-muted">{f.noApprovals}</p> : null}
          <ul className="space-y-3">
            {(pending.data ?? []).map((a) => {
              const inv = (Array.isArray(a.invoices) ? a.invoices[0] : a.invoices) as { number: string; currency: string } | undefined;
              return (
                <li key={a.id as string} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
                  <p>
                    <Badge>{f.kinds[a.kind as 'discount']}</Badge> <strong className="tabular-nums">{formatMoney(a.amount as string, inv?.currency)}</strong> · {f.invoice} {inv?.number ?? '—'} · {f.requestedBy}:{' '}
                    {nameOf(a.requested_by as string)}
                  </p>
                  <p className="text-sm">{a.reason as string}</p>
                  <div className="flex flex-wrap gap-3">
                    {(['approved', 'rejected'] as const).map((decision) => (
                      <ActionForm key={decision} action={decideAdjustmentAction} submitLabel={decision === 'approved' ? f.approve : f.reject} pendingLabel={t.common.pending} messages={msg} variant={decision === 'approved' ? 'primary' : 'secondary'}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="adjustmentId" value={a.id as string} />
                        <input type="hidden" name="decision" value={decision} />
                      </ActionForm>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {org ? (
        <section aria-labelledby="per-h" className="space-y-3">
          <h2 id="per-h" className="text-xl font-bold">
            {f.periodsTitle}
          </h2>
          <p className="text-sm text-muted">{f.periodHint}</p>
          <ul className="space-y-2">
            {(periods.data ?? []).map((p) => (
              <li key={p.id as string} className="flex flex-wrap items-center gap-3">
                <span>{(p.period_month as string).slice(0, 7)}</span>
                <Badge tone={p.status === 'closed' ? 'warning' : 'success'}>{p.status === 'closed' ? f.closed : f.open}</Badge>
                {p.reason ? <span className="text-sm text-muted">{p.reason as string}</span> : null}
                {scope.orgApprover(org) && p.status === 'closed' ? (
                  <ActionForm action={reopenPeriodAction} submitLabel={f.reopen} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ reason: f.reopenReason }} variant="secondary" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="periodId" value={p.id as string} />
                    <Field name="reason" label={f.reopenReason} required minLength={3} maxLength={500} idPrefix={`rp-${p.id as string}`} />
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {scope.orgApprover(org) ? (
            <ActionForm action={closePeriodAction} submitLabel={f.closeMonth} pendingLabel={t.common.pending} messages={msg} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="organizationId" value={org} />
              <Field name="month" label={f.month} type="month" required defaultValue={month} idPrefix="cp" />
            </ActionForm>
          ) : null}
        </section>
      ) : null}
      <p className="text-sm">
        <Link className="link" href={`/${locale}/app/billing`}>
          {f.billingTitle}
        </Link>
      </p>
    </WorkspacePage>
  );
}
