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
import { addRateAction, payrollDecisionAction, payrollGenerateAction } from '@/server/automation/actions';
import { formatMoney } from '@/server/finance/constants';
import { financeScope } from '@/server/finance/scope';
import { recentMonths, reportMonth } from '@/server/grading/month';
import { localDate } from '@/server/management/period';
import { createUserClient } from '@/server/supabase/server';

interface Statement {
  id: string;
  branch_id: string;
  teacher_id: string;
  month: string;
  currency: string;
  sessions: number;
  amount: string;
  status: 'draft' | 'approved' | 'paid';
  generated_by: string;
}

/** Зарплата: бухгалтерия — ставки, расчёт, утверждение и выплата; преподаватель — свои ведомости. */
export default async function PayrollPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ month?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/payroll`);
  const t = getDictionary(locale);
  const p = t.auto.payroll;
  const msg = authMessages(t);
  const scope = financeScope(ctx);
  const isTeacher = ctx.memberships.some((x) => x.status === 'active' && x.role === 'teacher');
  const org = scope.orgs[0];
  const db = await createUserClient();
  const { data: orgRow } = org ? await db.from('organizations').select('default_timezone').eq('id', org).maybeSingle() : { data: null };
  const tz = (orgRow?.default_timezone as string) ?? DEFAULT_TIMEZONE;
  const month = reportMonth((await searchParams).month, tz);

  // Преподаватель без финансовых прав: только свои утверждённые ведомости (RLS).
  if (!scope.canRead) {
    const { data: mine } = await db.from('payroll_statements').select('id, month, currency, sessions, amount, status').eq('teacher_id', ctx.user.id).order('month', { ascending: false }).limit(24);
    return (
      <WorkspacePage ctx={ctx} locale={locale} t={t} title={p.mine} allowed={isTeacher}>
        {(mine ?? []).length === 0 ? (
          <EmptyState title={p.mineNone} />
        ) : (
          <ul className="space-y-2">
            {(mine ?? []).map((s) => (
              <li key={s.id as string} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2">
                <span className="font-semibold">{String(s.month).slice(0, 7)}</span>
                <span>
                  {p.sessions}: {String(s.sessions)}
                </span>
                <span className="font-semibold">{formatMoney(s.amount as string, s.currency as string)}</span>
                <Badge tone={s.status === 'paid' ? 'success' : 'brand'}>{p.statuses[s.status as 'approved']}</Badge>
              </li>
            ))}
          </ul>
        )}
      </WorkspacePage>
    );
  }

  const [{ data: statements }, { data: rates }, { data: teachers }, { data: branches }] = await Promise.all([
    db.from('payroll_statements').select('id, branch_id, teacher_id, month, currency, sessions, amount, status, generated_by').eq('organization_id', org!).eq('month', `${month}-01`),
    db.from('teacher_rates').select('id, branch_id, teacher_id, amount, currency, valid_from').eq('organization_id', org!).order('valid_from', { ascending: false }).limit(200),
    db.from('memberships').select('profile_id, branch_id').eq('organization_id', org!).eq('role', 'teacher').eq('status', 'active'),
    db.from('branches').select('id, name').eq('organization_id', org!).eq('status', 'active').order('name'),
  ]);
  const ids = [...new Set([...(teachers ?? []).map((x) => x.profile_id as string), ...(statements ?? []).map((s) => s.teacher_id as string)])];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((x) => x.id === id)?.full_name as string) || '—';
  const branchName = (id: string | null) => (id ? ((branches ?? []).find((b) => b.id === id)?.name as string) ?? '—' : p.allBranches);
  const rows = ((statements ?? []) as Statement[]).sort((a, b) => nameOf(a.teacher_id).localeCompare(nameOf(b.teacher_id)));
  const teacherIds = [...new Set((teachers ?? []).map((x) => x.profile_id as string))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const decision = (s: Statement, d: 'approve' | 'pay', label: string) => (
    <ActionForm action={payrollDecisionAction} submitLabel={label} pendingLabel={t.common.pending} messages={msg} variant={d === 'pay' ? 'primary' : 'secondary'}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="statementId" value={s.id} />
      <input type="hidden" name="decision" value={d} />
    </ActionForm>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={p.title}>
      <FinanceTabs locale={locale} t={t} current="payroll" />

      <form method="get" className="flex flex-wrap items-end gap-3">
        <SelectField name="month" label={p.month} defaultValue={month} idPrefix="pm">
          {recentMonths(tz).map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </SelectField>
        <button type="submit" className="min-h-11 rounded-[var(--radius-control)] border border-border-strong px-4">
          {p.show}
        </button>
      </form>

      {scope.canWrite ? (
        <Card className="space-y-3">
          <p className="text-sm text-muted">{p.generateHint}</p>
          <ActionForm action={payrollGenerateAction} submitLabel={p.generate} pendingLabel={t.common.pending} messages={msg}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
            <input type="hidden" name="month" value={month} />
          </ActionForm>
        </Card>
      ) : null}

      <section aria-labelledby="st-h" className="space-y-3">
        <h2 id="st-h" className="text-xl font-bold">
          {p.title}: {month}
        </h2>
        <p className="text-sm text-muted">{p.approveHint}</p>
        {rows.length === 0 ? (
          <EmptyState title={p.none} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border-strong">
                  {[p.teacher, p.branch, p.sessions, p.total, ''].map((h, i) => (
                    <th key={i} scope="col" className="py-2 pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-border align-top">
                    <th scope="row" className="py-2 pr-3 font-normal">
                      {nameOf(s.teacher_id)}
                    </th>
                    <td className="py-2 pr-3">{branchName(s.branch_id)}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.sessions}</td>
                    <td className="py-2 pr-3 font-semibold tabular-nums">{formatMoney(s.amount, s.currency)}</td>
                    <td className="space-y-2 py-2">
                      <Badge tone={s.status === 'paid' ? 'success' : s.status === 'approved' ? 'brand' : 'neutral'}>{p.statuses[s.status]}</Badge>
                      {s.status === 'draft' && s.generated_by !== ctx.user.id && scope.branchCan('finance.approve', org!, s.branch_id) ? decision(s, 'approve', p.approve) : null}
                      {s.status === 'approved' && scope.branchCan('finance.write', org!, s.branch_id) ? decision(s, 'pay', p.pay) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="rates-h" className="space-y-3">
        <h2 id="rates-h" className="text-xl font-bold">
          {p.ratesTitle}
        </h2>
        <p className="text-sm text-muted">{p.rateHint}</p>
        {(rates ?? []).length === 0 ? (
          <p className="text-muted">{p.noRates}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(rates ?? []).map((r) => (
              <li key={r.id as string}>
                {nameOf(r.teacher_id as string)} · {branchName((r.branch_id as string | null) ?? null)} · {formatMoney(r.amount as string, r.currency as string)} · {p.validFrom}{' '}
                {formatDate(locale, r.valid_from as string)}
              </li>
            ))}
          </ul>
        )}
        {scope.canWrite ? (
          <Card>
            <ActionForm action={addRateAction} submitLabel={p.addRate} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ amount: p.amount, validFrom: p.validFrom, teacherId: p.teacher }} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="organizationId" value={org} />
              <SelectField name="teacherId" label={p.teacher} required idPrefix="rt">
                {teacherIds.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
              </SelectField>
              <SelectField name="branchId" label={p.branch} defaultValue="" idPrefix="rt">
                <option value="">{p.allBranches}</option>
                {(branches ?? []).map((b) => (
                  <option key={b.id as string} value={b.id as string}>
                    {b.name as string}
                  </option>
                ))}
              </SelectField>
              <Field name="amount" inputMode="decimal" label={p.amount} required idPrefix="rt" />
              <Field name="currency" label={p.currency} defaultValue="KGS" required maxLength={3} idPrefix="rt" />
              <Field name="validFrom" type="date" label={p.validFrom} required defaultValue={`${localDate(tz).slice(0, 7)}-01`} idPrefix="rt" />
            </ActionForm>
          </Card>
        ) : null}
      </section>
    </WorkspacePage>
  );
}
