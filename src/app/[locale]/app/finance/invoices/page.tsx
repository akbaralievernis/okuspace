import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { FinanceTabs } from '@/features/finance/finance-tabs';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { createInvoiceAction } from '@/server/finance/actions';
import { formatMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { createUserClient } from '@/server/supabase/server';

export default async function InvoicesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ status?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance/invoices`);
  const t = getDictionary(locale);
  const f = t.finance;
  const scope = financeScope(ctx);
  const sp = await searchParams;
  const db = await createUserClient();
  let q = db.from('invoices').select('id, number, status, currency, due_on, payer_id, branch_id, created_at').order('created_at', { ascending: false }).limit(200);
  if (sp.status && ['draft', 'issued', 'void'].includes(sp.status)) q = q.eq('status', sp.status);
  const org = scope.orgs[0];
  const [{ data: invoices }, { data: balances }, { data: branches }, { data: students }] = await Promise.all([
    scope.canRead ? q : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    scope.canRead ? db.from('invoice_balances').select('invoice_id, due, paid, outstanding, payment_status') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    org ? db.from('branches').select('id, name').eq('organization_id', org).order('name') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    org && scope.canWrite ? db.from('memberships').select('profile_id, branch_id').eq('organization_id', org).eq('role', 'student').eq('status', 'active') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const ids = [...new Set([...(invoices ?? []).map((i) => i.payer_id as string), ...(students ?? []).map((s) => s.profile_id as string)])];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const balOf = (id: string) => (balances ?? []).find((b) => b.invoice_id === id);
  const writable = (branches ?? []).filter((b) => scope.branchCan('finance.write', org!, b.id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={f.invoices} allowed={scope.canRead}>
      <FinanceTabs locale={locale} t={t} current="invoices" />
      <p className="flex flex-wrap gap-3 text-sm">
        {(['', 'draft', 'issued', 'void'] as const).map((s) => (
          <Link key={s} className="link" href={`/${locale}/app/finance/invoices${s ? `?status=${s}` : ''}`}>
            {s ? f.invoiceStatuses[s] : t.crm.all}
          </Link>
        ))}
      </p>
      {(invoices ?? []).length === 0 ? (
        <EmptyState title={f.empty} />
      ) : (
        <ul className="space-y-2">
          {(invoices ?? []).map((i) => {
            const b = balOf(i.id as string);
            return (
              <li key={i.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
                <span>
                  <Link className="link font-semibold" href={`/${locale}/app/finance/invoices/${i.id as string}`}>
                    {i.number as string}
                  </Link>{' '}
                  · {nameOf(i.payer_id as string)}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={b?.payment_status === 'paid' ? 'success' : i.status === 'void' ? 'warning' : 'neutral'}>{f.paymentStatuses[(b?.payment_status ?? i.status) as 'paid']}</Badge>
                  {b ? (
                    <span className="tabular-nums">
                      {f.due}: {formatMoney(b.due as string, i.currency as string)} · {f.outstanding}: {formatMoney(b.outstanding as string, i.currency as string)}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {scope.canWrite && writable.length ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{f.newInvoice}</h2>
          <ActionForm action={createInvoiceAction} submitLabel={f.create} pendingLabel={t.common.pending} messages={authMessages(t)} fieldLabels={{ number: f.number, payerId: f.payer }} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org!} />
            <SelectField name="branchId" label={f.branch} idPrefix="ni">
              {writable.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
            </SelectField>
            <SelectField name="payerId" label={f.payer} idPrefix="ni">
              {[...new Set((students ?? []).map((s) => s.profile_id as string))].map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </SelectField>
            <Field name="number" label={f.number} required maxLength={40} pattern="[A-Za-z0-9/._-]{1,40}" idPrefix="ni" />
            <Field name="dueOn" label={f.dueOn} type="date" idPrefix="ni" />
            <input type="hidden" name="currency" value="KGS" />
            <TextareaField name="description" label={f.description} maxLength={2000} rows={2} idPrefix="ni" />
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}
