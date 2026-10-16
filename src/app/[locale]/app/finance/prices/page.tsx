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
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { addTariffAction, archiveTariffAction, createPriceListAction, setPriceListStatusAction } from '@/server/finance/actions';
import { TARIFF_UNITS, formatMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { createUserClient } from '@/server/supabase/server';

export default async function PricesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/finance/prices`);
  const t = getDictionary(locale);
  const f = t.finance;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const m = scope.m;
  // Прайс-листы видят финансы и продажи (для консультаций), меняют — утверждающие.
  const readers = m.some((x) => can(m, 'finance.read', x.organizationId, x.branchId) || can(m, 'lead.read', x.organizationId, x.branchId));
  const org = m.find((x) => can(m, 'finance.read', x.organizationId, x.branchId) || can(m, 'lead.read', x.organizationId, x.branchId))?.organizationId;
  const db = await createUserClient();
  const [{ data: lists }, { data: tariffs }, { data: branches }, { data: courses }] = org
    ? await Promise.all([
        db.from('price_lists').select('*').eq('organization_id', org).order('valid_from', { ascending: false }),
        db.from('tariffs').select('*').eq('organization_id', org).order('created_at'),
        db.from('branches').select('id, name').eq('organization_id', org).order('name'),
        db.from('courses').select('id, title').eq('organization_id', org).order('title'),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const approve = (branch: string | null) => Boolean(org) && can(m, 'finance.approve', org!, branch);
  const branchName = (id: string | null) => (id ? (((branches ?? []).find((b) => b.id === id)?.name as string) ?? '—') : f.allBranches);

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={f.priceLists} allowed={readers}>
      {scope.canRead ? <FinanceTabs locale={locale} t={t} current="prices" /> : null}
      <p className="text-sm text-muted">{f.priceHint}</p>
      {(lists ?? []).length === 0 ? <EmptyState title={f.empty} /> : null}
      {(lists ?? []).map((l) => {
        const canEdit = approve(l.branch_id as string | null);
        return (
          <section key={l.id as string} aria-labelledby={`pl-${l.id as string}`} className="space-y-3 rounded-[var(--radius-card)] border border-border p-4">
            <h2 id={`pl-${l.id as string}`} className="flex flex-wrap items-center gap-2 text-lg font-bold">
              {l.name as string} <Badge tone={l.status === 'active' ? 'success' : 'neutral'}>{f.listStatuses[l.status as 'draft']}</Badge>
            </h2>
            <p className="text-sm text-muted">
              {branchName(l.branch_id as string | null)} · {formatDate(locale, l.valid_from as string)}
              {l.valid_to ? ` — ${formatDate(locale, l.valid_to as string)}` : ''} · {l.currency as string}
            </p>
            <ul className="space-y-1">
              {(tariffs ?? [])
                .filter((tf) => tf.price_list_id === l.id)
                .map((tf) => (
                  <li key={tf.id as string} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1">
                    <span>
                      {tf.name as string} · {f.units[tf.unit as 'month']}
                      {tf.lessons ? ` · ${f.lessons}: ${String(tf.lessons)}` : ''}
                      {tf.status === 'archived' ? (
                        <>
                          {' '}
                          <Badge>{f.listStatuses.archived}</Badge>
                        </>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <strong className="tabular-nums">{formatMoney(tf.amount as string, l.currency as string)}</strong>
                      {canEdit && tf.status === 'active' ? (
                        <ActionForm action={archiveTariffAction} submitLabel={f.archive} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="tariffId" value={tf.id as string} />
                        </ActionForm>
                      ) : null}
                    </span>
                  </li>
                ))}
            </ul>
            {canEdit ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {(['active', 'archived'] as const)
                    .filter((s) => s !== l.status)
                    .map((s) => (
                      <ActionForm key={s} action={setPriceListStatusAction} submitLabel={s === 'active' ? f.activate : f.archive} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="priceListId" value={l.id as string} />
                        <input type="hidden" name="status" value={s} />
                      </ActionForm>
                    ))}
                </div>
                <ActionForm action={addTariffAction} submitLabel={f.newTariff} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ name: f.name, amount: f.amount }} className="grid gap-3 sm:grid-cols-3">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="organizationId" value={org!} />
                  <input type="hidden" name="priceListId" value={l.id as string} />
                  <Field name="name" label={f.name} required maxLength={120} idPrefix={`tf-${l.id as string}`} />
                  <SelectField name="unit" label={f.unit} idPrefix={`tf-${l.id as string}`}>
                    {TARIFF_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {f.units[u]}
                      </option>
                    ))}
                  </SelectField>
                  <Field name="amount" label={f.amount} required inputMode="decimal" idPrefix={`tf-${l.id as string}`} />
                  <Field name="lessons" label={f.lessons} type="number" min={1} max={500} idPrefix={`tf-${l.id as string}`} />
                  <SelectField name="courseId" label={f.course} idPrefix={`tf-${l.id as string}`}>
                    <option value="">—</option>
                    {(courses ?? []).map((c) => (
                      <option key={c.id as string} value={c.id as string}>
                        {c.title as string}
                      </option>
                    ))}
                  </SelectField>
                </ActionForm>
              </>
            ) : null}
          </section>
        );
      })}
      {org && (approve(null) || (branches ?? []).some((b) => approve(b.id as string))) ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{f.newPriceList}</h2>
          <ActionForm action={createPriceListAction} submitLabel={f.create} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ name: f.name, validFrom: f.validFrom, validTo: f.validTo }} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
            <input type="hidden" name="currency" value="KGS" />
            <Field name="name" label={f.name} required maxLength={120} idPrefix="npl" />
            <SelectField name="branchId" label={f.branch} idPrefix="npl">
              {approve(null) ? <option value="">{f.allBranches}</option> : null}
              {(branches ?? [])
                .filter((b) => approve(b.id as string))
                .map((b) => (
                  <option key={b.id as string} value={b.id as string}>
                    {b.name as string}
                  </option>
                ))}
            </SelectField>
            <Field name="validFrom" label={f.validFrom} type="date" required idPrefix="npl" />
            <Field name="validTo" label={f.validTo} type="date" idPrefix="npl" />
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}
