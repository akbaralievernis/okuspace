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
import { recordExpenseAction, reverseExpenseAction } from '@/server/finance/actions';
import { EXPENSE_CATEGORIES, formatMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { localDate } from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

export default async function ExpensesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance/expenses`);
  const t = getDictionary(locale);
  const f = t.finance;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const org = scope.orgs[0];
  const db = await createUserClient();
  const [{ data: expenses }, { data: branches }] = await Promise.all([
    scope.canRead ? db.from('expenses').select('*').order('spent_on', { ascending: false }).order('created_at', { ascending: false }).limit(200) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    org ? db.from('branches').select('id, name').eq('organization_id', org).order('name') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const reversedIds = new Set((expenses ?? []).map((e) => e.reverses_expense_id as string | null).filter(Boolean));
  const branchName = (id: string) => ((branches ?? []).find((b) => b.id === id)?.name as string) ?? '—';
  const writable = (branches ?? []).filter((b) => scope.branchCan('finance.write', org!, b.id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={f.expenses} allowed={scope.canRead}>
      <FinanceTabs locale={locale} t={t} current="expenses" />
      {(expenses ?? []).length === 0 ? <EmptyState title={f.empty} /> : null}
      <ul className="space-y-2">
        {(expenses ?? []).map((e) => {
          const reversal = Boolean(e.reverses_expense_id);
          return (
            <li key={e.id as string} className="space-y-1 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {formatDate(locale, e.spent_on as string)} · {branchName(e.branch_id as string)} · {f.categories[e.category as 'rent']} · {e.description as string}
                  {e.vendor ? ` · ${e.vendor as string}` : ''}
                </span>
                <span className="flex items-center gap-2">
                  {reversal ? <Badge tone="warning">{f.reversal}</Badge> : reversedIds.has(e.id as string) ? <Badge>{f.reversed}</Badge> : null}
                  <strong className="tabular-nums">
                    {reversal ? '−' : ''}
                    {formatMoney(e.amount as string, e.currency as string)}
                  </strong>
                </span>
              </p>
              {reversal ? <p className="text-sm text-muted">{e.reason as string}</p> : null}
              {!reversal && !reversedIds.has(e.id as string) && scope.branchCan('finance.write', e.organization_id as string, e.branch_id as string) ? (
                <ActionForm action={reverseExpenseAction} submitLabel={f.reverse} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ reason: f.reason }} variant="secondary" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="expenseId" value={e.id as string} />
                  <Field name="reason" label={f.reason} required minLength={3} maxLength={500} idPrefix={`rv-${e.id as string}`} />
                </ActionForm>
              ) : null}
            </li>
          );
        })}
      </ul>
      {scope.canWrite && writable.length ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{f.recordExpense}</h2>
          <ActionForm action={recordExpenseAction} submitLabel={f.recordExpense} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: f.amount, description: f.description, spentOn: f.spentOn }} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org!} />
            <input type="hidden" name="currency" value="KGS" />
            <SelectField name="branchId" label={f.branch} idPrefix="ne">
              {writable.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
            </SelectField>
            <SelectField name="category" label={f.category} idPrefix="ne">
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {f.categories[c]}
                </option>
              ))}
            </SelectField>
            <Field name="amount" label={f.amount} required inputMode="decimal" idPrefix="ne" />
            <Field name="spentOn" label={f.spentOn} type="date" required defaultValue={localDate(new Date(), DEFAULT_TIMEZONE)} idPrefix="ne" />
            <Field name="description" label={f.description} required maxLength={500} idPrefix="ne" />
            <Field name="vendor" label={f.vendor} maxLength={200} idPrefix="ne" />
            <Field name="documentRef" label={f.documentRef} maxLength={100} idPrefix="ne" />
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}
