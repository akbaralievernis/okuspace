import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import type { Role } from '@/server/authz/permissions';
import { createTaskAction } from '@/server/management/actions';
import { ASSIGNABLE_ROLES, PRIORITIES } from '@/server/management/constants';
import { isOverdue, nowMs } from '@/server/management/period';
import { createUserClient } from '@/server/supabase/server';

type Show = 'active' | 'overdue' | 'all';
interface TaskRow {
  id: string;
  organization_id: string;
  branch_id: string | null;
  batch_id: string;
  title: string;
  priority: string;
  status: string;
  due_at: string | null;
  assignee_id: string;
  created_by: string;
}

const COLUMNS = 'id, organization_id, branch_id, batch_id, title, priority, status, due_at, assignee_id, created_by';
const STAFF_ROLES: readonly string[] = [...ASSIGNABLE_ROLES, 'org_director'];

export default async function TasksPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ show?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/tasks`);
  const t = getDictionary(locale);
  const k = t.mgmt.tasks;
  const msg = authMessages(t);
  const sp = await searchParams;
  const show: Show = sp.show === 'overdue' || sp.show === 'all' ? sp.show : 'active';
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const isStaff = m.some((x) => STAFF_ROLES.includes(x.role));
  const managerOrgs = [...new Set(m.filter((x) => can(m, 'task.manage', x.organizationId, x.branchId)).map((x) => x.organizationId))];
  const db = await createUserClient();

  const statuses = show === 'all' ? ['open', 'in_progress', 'submitted', 'done', 'cancelled'] : show === 'overdue' ? ['open', 'in_progress'] : ['open', 'in_progress', 'submitted'];
  const [{ data: mine }, { data: managed }, { data: staff }, { data: branches }, { data: orgs }] = await Promise.all([
    db.from('staff_tasks').select(COLUMNS).eq('assignee_id', ctx.user.id).in('status', statuses).order('due_at', { ascending: true, nullsFirst: false }).limit(100),
    managerOrgs.length
      ? db.from('staff_tasks').select(COLUMNS).neq('assignee_id', ctx.user.id).in('organization_id', managerOrgs).in('status', statuses).order('created_at', { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as TaskRow[] }),
    managerOrgs.length
      ? db.from('memberships').select('organization_id, branch_id, profile_id, role').in('organization_id', managerOrgs).eq('status', 'active').in('role', [...ASSIGNABLE_ROLES])
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    db.from('branches').select('id, name').in('organization_id', [...new Set(m.map((x) => x.organizationId))]),
    managerOrgs.length ? db.from('organizations').select('id, default_timezone').in('id', managerOrgs) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const now = nowMs();
  const keep = (rows: TaskRow[] | null) => (rows ?? []).filter((r) => show !== 'overdue' || isOverdue(r.status, r.due_at, now));
  const mineRows = keep(mine as TaskRow[] | null);
  const managedRows = keep(managed as TaskRow[] | null);

  // Кому текущий руководитель может поставить задачу (БД проверит то же самое).
  const targets = (staff ?? [])
    .filter((s) => s.profile_id !== ctx.user.id && can(m, 'task.manage', s.organization_id as string, (s.branch_id as string | null) ?? null))
    .filter((s) => s.organization_id === managerOrgs[0]);
  const ids = [...new Set([...mineRows, ...managedRows].flatMap((r) => [r.assignee_id, r.created_by]).concat(targets.map((s) => s.profile_id as string)))];
  const { data: people } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((people ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const branchOf = (id: string | null) => (id ? ((branches ?? []).find((b) => b.id === id)?.name as string) ?? '—' : k.wholeSchool);
  const tz = ((orgs ?? [])[0]?.default_timezone as string) ?? DEFAULT_TIMEZONE;

  const batches = new Map<string, TaskRow[]>();
  for (const r of managedRows) batches.set(r.batch_id, [...(batches.get(r.batch_id) ?? []), r]);

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={k.title} allowed={isStaff}>
      <nav aria-label={k.filter} className="flex flex-wrap gap-3 text-sm">
        {(['active', 'overdue', 'all'] as const).map((s) => (
          <Link key={s} className="link" aria-current={show === s ? 'page' : undefined} href={`/${locale}/app/tasks${s === 'active' ? '' : `?show=${s}`}`}>
            {s === 'active' ? k.filterActive : s === 'overdue' ? k.filterOverdue : k.filterAll}
          </Link>
        ))}
      </nav>

      <section aria-labelledby="mine-h" className="space-y-3">
        <h2 id="mine-h" className="text-xl font-bold">
          {k.mine}
        </h2>
        {mineRows.length === 0 ? <EmptyState title={k.none} /> : <TaskList rows={mineRows} locale={locale} t={t} tz={tz} nameOf={nameOf} branchOf={branchOf} who="author" now={now} />}
      </section>

      {managerOrgs.length ? (
        <section aria-labelledby="managed-h" className="space-y-3">
          <h2 id="managed-h" className="text-xl font-bold">
            {k.managed}
          </h2>
          {managedRows.length === 0 ? (
            <EmptyState title={k.none} />
          ) : (
            <ul className="space-y-3">
              {[...batches.values()].map((rows) => (
                <li key={rows[0]!.batch_id}>
                  {rows.length > 1 ? (
                    <p className="mb-1 text-sm text-muted">
                      {fmt(k.batch, { done: String(rows.filter((r) => r.status === 'done').length), total: String(rows.length) })}
                    </p>
                  ) : null}
                  <TaskList rows={rows} locale={locale} t={t} tz={tz} nameOf={nameOf} branchOf={branchOf} who="assignee" now={now} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {managerOrgs.length ? (
        <Card>
          <h2 className="mb-3 text-xl font-bold">{k.newTitle}</h2>
          {targets.length === 0 ? (
            <p>{k.noStaff}</p>
          ) : (
            <ActionForm
              action={createTaskAction}
              submitLabel={k.create}
              pendingLabel={t.common.pending}
              messages={msg}
              fieldLabels={{ title: k.fTitle, description: k.fDescription, dueDate: k.fDueDate, dueTime: k.fDueTime, targets: k.fAssignees }}
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="organizationId" value={managerOrgs[0]} />
              <Field name="title" label={k.fTitle} required minLength={2} maxLength={200} idPrefix="nt" />
              <TextareaField name="description" label={k.fDescription} maxLength={5000} idPrefix="nt" />
              <SelectField name="priority" label={k.fPriority} defaultValue="normal" idPrefix="nt">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {k.priority[p]}
                  </option>
                ))}
              </SelectField>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="dueDate" type="date" label={k.fDueDate} hint={k.dueHint} idPrefix="nt" />
                <Field name="dueTime" type="time" label={k.fDueTime} idPrefix="nt" />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{k.fAssignees}</legend>
                <p className="text-sm text-muted">{k.assigneesHint}</p>
                {targets.map((s) => {
                  const value = `${s.profile_id as string}|${(s.branch_id as string | null) ?? ''}`;
                  return (
                    <label key={value} className="flex items-start gap-3 text-sm">
                      <input type="checkbox" name="target" value={value} className="mt-0.5 size-5 shrink-0 accent-brand-700" />
                      <span>
                        {nameOf(s.profile_id as string)} — {t.roles[s.role as Role]}, {branchOf((s.branch_id as string | null) ?? null)}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            </ActionForm>
          )}
        </Card>
      ) : null}
    </WorkspacePage>
  );
}

function TaskList({
  rows,
  locale,
  t,
  tz,
  nameOf,
  branchOf,
  who,
  now,
}: {
  rows: TaskRow[];
  locale: Locale;
  t: Dictionary;
  tz: string;
  nameOf: (id: string) => string;
  branchOf: (id: string | null) => string;
  who: 'author' | 'assignee';
  now: number;
}) {
  const k = t.mgmt.tasks;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="space-y-1 rounded-[var(--radius-control)] border border-border px-3 py-2">
          <p className="flex flex-wrap items-center gap-2">
            <Link className="link font-semibold" href={`/${locale}/app/tasks/${r.id}`}>
              {r.title}
            </Link>
            <Badge tone={r.status === 'done' ? 'success' : r.status === 'submitted' ? 'brand' : 'neutral'}>{k.status[r.status as keyof typeof k.status]}</Badge>
            {isOverdue(r.status, r.due_at, now) ? <Badge tone="warning">{k.overdue}</Badge> : null}
            {r.priority === 'high' || r.priority === 'urgent' ? <Badge tone="warning">{k.priority[r.priority]}</Badge> : null}
          </p>
          <p className="flex flex-wrap gap-x-4 text-sm text-muted">
            <span>
              {who === 'author' ? k.author : k.assignee}: {nameOf(who === 'author' ? r.created_by : r.assignee_id)}
            </span>
            <span>
              {k.branch}: {branchOf(r.branch_id)}
            </span>
            <span>
              {k.due}: {r.due_at ? formatShortDateTime(locale, r.due_at, tz) : k.noDue}
            </span>
          </p>
        </li>
      ))}
    </ul>
  );
}
