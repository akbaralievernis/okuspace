import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { FinanceTabs } from '@/features/finance/finance-tabs';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { billingGenerateAction, billingIssueAction } from '@/server/automation/actions';
import { formatMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { recentMonths } from '@/server/grading/month';
import { localDate } from '@/server/management/period';
import { createUserClient } from '@/server/supabase/server';

/** Счета за месяц: сформировать черновики по записям и тарифам, выставить их одной кнопкой. */
export default async function BillingPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ month?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance/billing`);
  const t = getDictionary(locale);
  const b = t.auto.billing;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const org = scope.orgs[0];
  const db = await createUserClient();
  const { data: orgRow } = org ? await db.from('organizations').select('default_timezone').eq('id', org).maybeSingle() : { data: null };
  const tz = (orgRow?.default_timezone as string) ?? DEFAULT_TIMEZONE;
  // По умолчанию — следующий месяц: счета обычно формируют заранее.
  const months = recentMonths(tz, 12, new Date(Date.parse(`${localDate(tz).slice(0, 7)}-15T00:00:00Z`) + 31 * 86_400_000));
  const sp = await searchParams;
  const month = sp.month && months.includes(sp.month) ? sp.month : months[0]!;

  const { data: invoices } = org
    ? await db.from('invoices').select('id, number, status, currency, total, due_on, payer_id').eq('organization_id', org).eq('billing_month', `${month}-01`).order('number')
    : { data: [] as Record<string, unknown>[] };
  const ids = [...new Set((invoices ?? []).map((i) => i.payer_id as string))];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const drafts = (invoices ?? []).filter((i) => i.status === 'draft').length;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organizationId" value={org ?? ''} />
      <input type="hidden" name="month" value={month} />
    </>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={b.title} allowed={scope.canRead}>
      <FinanceTabs locale={locale} t={t} current="billing" />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <SelectField name="month" label={b.month} defaultValue={month} idPrefix="bm">
          {months.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </SelectField>
        <button type="submit" className="min-h-11 rounded-[var(--radius-control)] border border-border-strong px-4">
          {b.show}
        </button>
      </form>

      {scope.canWrite && org ? (
        <Card className="space-y-4">
          <p className="text-sm text-muted">{b.generateHint}</p>
          <ActionForm action={billingGenerateAction} submitLabel={b.generate} pendingLabel={t.common.pending} messages={msg} className="flex flex-wrap items-end gap-3">
            {hidden}
            <Field name="dueDay" type="number" min={1} max={28} defaultValue="10" label={b.dueDay} idPrefix="bg" />
          </ActionForm>
          {drafts > 0 ? (
            <>
              <p className="text-sm text-muted">{b.issueHint}</p>
              <ActionForm action={billingIssueAction} submitLabel={`${b.issue} (${drafts})`} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                {hidden}
              </ActionForm>
            </>
          ) : null}
        </Card>
      ) : null}

      {(invoices ?? []).length === 0 ? (
        <EmptyState title={b.none} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">
              {b.title} {month}
            </caption>
            <thead>
              <tr className="border-b border-border-strong">
                {[b.number, b.payer, b.amount, b.due, b.status].map((h) => (
                  <th key={h} scope="col" className="py-2 pr-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(invoices ?? []).map((i) => (
                <tr key={i.id as string} className="border-b border-border">
                  <th scope="row" className="py-2 pr-3 font-normal">
                    <Link className="link" href={`/${locale}/app/finance/invoices/${i.id as string}`}>
                      {i.number as string}
                    </Link>
                  </th>
                  <td className="py-2 pr-3">{nameOf(i.payer_id as string)}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatMoney(i.total as string, i.currency as string)}</td>
                  <td className="py-2 pr-3">{i.due_on ? formatDate(locale, i.due_on as string) : '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={i.status === 'issued' ? 'success' : 'neutral'}>{b.statuses[i.status as 'draft']}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WorkspacePage>
  );
}
