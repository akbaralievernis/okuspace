import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Field } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatPrice } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { parsePeriodQuery, presetPeriod } from '@/server/management/period';
import { createUserClient } from '@/server/supabase/server';

interface Money {
  received: string;
  refunded: string;
  outstanding: string;
  overdue: string;
}
interface BranchRow {
  branchId: string;
  branch: string;
  students: number;
  groups: number;
  teachers: number;
  sessions: { planned: number; done: number; cancelled: number; unmarked: number };
  attendance: { marked: number; present: number };
  homework: { waiting: number; overdue: number };
  leads: { new: number; won: number };
  tasks: { open: number; overdue: number; done: number };
  announcements: { published: number; ackRequested: number; acknowledged: number };
  finance: Record<string, Money> | null;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '—');

/** Итог по школе: суммы счётчиков; проценты — из сумм, а не среднее процентов. */
function total(rows: BranchRow[]): BranchRow {
  const sum = (f: (r: BranchRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const visible = rows.filter((r) => r.finance);
  const currencies = [...new Set(visible.flatMap((r) => Object.keys(r.finance!)))];
  return {
    branchId: 'total',
    branch: '',
    students: sum((r) => r.students),
    groups: sum((r) => r.groups),
    teachers: sum((r) => r.teachers),
    sessions: { planned: sum((r) => r.sessions.planned), done: sum((r) => r.sessions.done), cancelled: sum((r) => r.sessions.cancelled), unmarked: sum((r) => r.sessions.unmarked) },
    attendance: { marked: sum((r) => r.attendance.marked), present: sum((r) => r.attendance.present) },
    homework: { waiting: sum((r) => r.homework.waiting), overdue: sum((r) => r.homework.overdue) },
    leads: { new: sum((r) => r.leads.new), won: sum((r) => r.leads.won) },
    tasks: { open: sum((r) => r.tasks.open), overdue: sum((r) => r.tasks.overdue), done: sum((r) => r.tasks.done) },
    announcements: { published: sum((r) => r.announcements.published), ackRequested: sum((r) => r.announcements.ackRequested), acknowledged: sum((r) => r.announcements.acknowledged) },
    finance: visible.length === rows.length && rows.length
      ? Object.fromEntries(
          currencies.map((c) => {
            const add = (k: keyof Money) => visible.reduce((a, r) => a + Number(r.finance![c]?.[k] ?? 0), 0).toFixed(2);
            return [c, { received: add('received'), refunded: add('refunded'), outstanding: add('outstanding'), overdue: add('overdue') }];
          }),
        )
      : null,
  };
}

export default async function DashboardPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ from?: string; to?: string; org?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/dashboard`);
  const t = getDictionary(locale);
  const d = t.mgmt.dash;
  const sp = await searchParams;
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const orgs = [...new Set(m.filter((x) => can(m, 'dashboard.read', x.organizationId, x.branchId)).map((x) => x.organizationId))];
  const org = orgs.find((o) => o === sp.org) ?? orgs[0];
  const db = await createUserClient();
  const { data: orgRow } = org ? await db.from('organizations').select('default_timezone').eq('id', org).maybeSingle() : { data: null };
  const tz = (orgRow?.default_timezone as string) ?? DEFAULT_TIMEZONE;
  const period = parsePeriodQuery(sp.from, sp.to, tz);
  const { data } = org ? await db.rpc('branch_dashboard', { p_org: org, p_from: period.from, p_to: period.to }) : { data: [] };
  const rows = (data ?? []) as BranchRow[];
  const cols = rows.length > 1 ? [...rows, total(rows)] : rows;
  const currencies = [...new Set(cols.flatMap((r) => Object.keys(r.finance ?? {})))];
  const head = (r: BranchRow) => (r.branchId === 'total' ? d.total : r.branch);
  const warn = (n: number) => (n > 0 ? 'font-semibold text-danger-700' : '');
  const money = (r: BranchRow, c: string, k: keyof Money) => (r.finance ? formatPrice(locale, r.finance[c]?.[k] ?? '0.00', c) : d.noAccess);
  const q = (p: { from: string; to: string }) => `/${locale}/app/dashboard?from=${p.from}&to=${p.to}${org && orgs.length > 1 ? `&org=${org}` : ''}`;

  type Line = { label: string; cell: (r: BranchRow) => string; alert?: (r: BranchRow) => number };
  const lines: Line[] = [
    { label: d.rows.students, cell: (r) => String(r.students) },
    { label: d.rows.groups, cell: (r) => String(r.groups) },
    { label: d.rows.teachers, cell: (r) => String(r.teachers) },
    { label: d.rows.sessions, cell: (r) => `${r.sessions.done} / ${r.sessions.planned}` },
    { label: d.rows.cancelled, cell: (r) => String(r.sessions.cancelled) },
    { label: d.rows.unmarked, cell: (r) => String(r.sessions.unmarked), alert: (r) => r.sessions.unmarked },
    { label: d.rows.attendance, cell: (r) => pct(r.attendance.present, r.attendance.marked) },
    { label: d.rows.homework, cell: (r) => String(r.homework.waiting) },
    { label: d.rows.homeworkOverdue, cell: (r) => String(r.homework.overdue), alert: (r) => r.homework.overdue },
    { label: d.rows.leads, cell: (r) => `${r.leads.new} / ${r.leads.won}` },
    { label: d.rows.tasks, cell: (r) => `${r.tasks.open} / ${r.tasks.overdue}`, alert: (r) => r.tasks.overdue },
    { label: d.rows.tasksDone, cell: (r) => String(r.tasks.done) },
    { label: d.rows.ack, cell: (r) => pct(r.announcements.acknowledged, r.announcements.ackRequested) },
    ...currencies.flatMap((c): Line[] => [
      { label: `${d.rows.received} (${c})`, cell: (r) => money(r, c, 'received') },
      { label: `${d.rows.outstanding} (${c})`, cell: (r) => money(r, c, 'outstanding') },
      { label: `${d.rows.overdue} (${c})`, cell: (r) => money(r, c, 'overdue'), alert: (r) => Number(r.finance?.[c]?.overdue ?? 0) },
    ]),
  ];

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={d.title} allowed={orgs.length > 0}>
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label={d.period}>
        {org && orgs.length > 1 ? <input type="hidden" name="org" value={org} /> : null}
        <Field name="from" type="date" label={d.from} defaultValue={period.from} idPrefix="dp" />
        <Field name="to" type="date" label={d.to} defaultValue={period.to} idPrefix="dp" />
        <button type="submit" className="min-h-11 rounded-[var(--radius-control)] border border-border-strong px-4">
          {d.show}
        </button>
      </form>
      {org && can(m, 'grading.manage', org, null) ? (
        <p>
          <Link className="link" href={`/${locale}/app/grading`}>
            {t.grades.policyLink}
          </Link>
        </p>
      ) : null}
      <p className="flex flex-wrap gap-4 text-sm">
        {(['p7', 'p30', 'pMonth'] as const).map((p) => (
          <Link key={p} className="link" href={q(presetPeriod(p, tz))}>
            {d[p]}
          </Link>
        ))}
      </p>

      {rows.length === 0 ? (
        <EmptyState title={d.none} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <caption className="sr-only">
              {d.title}: {period.from} — {period.to}
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4">
                  {d.metric}
                </th>
                {cols.map((r) => (
                  <th key={r.branchId} scope="col" className="py-2 pr-4">
                    {head(r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.label} className="border-b border-border">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {l.label}
                  </th>
                  {cols.map((r) => (
                    <td key={r.branchId} className={`py-2 pr-4 tabular-nums ${l.alert ? warn(l.alert(r)) : ''}`}>
                      {l.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">{d.definitionsTitle}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          {d.definitions.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
    </WorkspacePage>
  );
}
