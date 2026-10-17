import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { makeupResolveAction, makeupScheduleAction } from '@/server/automation/actions';
import { nowMs } from '@/server/management/period';
import { parsePeriod } from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

interface Req {
  id: string;
  branch_id: string;
  organization_id: string;
  student_id: string;
  status: 'open' | 'scheduled' | 'done' | 'cancelled';
  note: string | null;
  missed: { period: string; groups: { name: string } | null } | null;
  makeup: { id: string; period: string; groups: { name: string } | null } | null;
}

/** Отработки: заявки появляются сами при пропуске; администратор назначает занятие. */
export default async function MakeupsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ show?: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/schedule/makeups`);
  const t = getDictionary(locale);
  const k = t.auto.makeups;
  const msg = authMessages(t);
  const showAll = (await searchParams).show === 'all';
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const manages = (org: string, branch: string) => can(m, 'schedule.manage', org, branch) || can(m, 'attendance.manage', org, branch);
  const allowed = m.some((x) => can(m, 'schedule.manage', x.organizationId, x.branchId) || can(m, 'attendance.manage', x.organizationId, x.branchId));
  const db = await createUserClient();

  let q = db
    .from('makeup_requests')
    .select('id, organization_id, branch_id, student_id, status, note, missed:lesson_sessions!makeup_requests_missed_session_id_fkey(period, groups(name)), makeup:lesson_sessions!makeup_requests_makeup_session_id_fkey(id, period, groups(name))')
    .order('created_at', { ascending: false })
    .limit(200);
  if (!showAll) q = q.in('status', ['open', 'scheduled']);
  const [{ data }, { data: upcoming }] = await Promise.all([
    q,
    db
      .from('lesson_sessions')
      .select('id, branch_id, period, groups(name)')
      .eq('status', 'scheduled')
      // Занятия строго после текущего момента (оператор диапазонов «справа от»).
      .rangeGt('period', `[${new Date(nowMs()).toISOString()},${new Date(nowMs()).toISOString()}]`)
      .order('period')
      .limit(300),
  ]);
  const reqs = ((data ?? []) as unknown as Req[]).filter((r) => manages(r.organization_id, r.branch_id));
  const ids = [...new Set(reqs.map((r) => r.student_id))];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const when = (period: string | undefined) => (period ? formatShortDateTime(locale, parsePeriod(period)[0], DEFAULT_TIMEZONE) : '—');
  const future = (upcoming ?? []).filter((s) => Date.parse(parsePeriod(s.period as string)[0]) > nowMs());

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={k.title} allowed={allowed}>
      <p className="text-sm text-muted">{k.hint}</p>
      <nav aria-label={k.show} className="flex gap-3 text-sm">
        <Link className="link" aria-current={!showAll ? 'page' : undefined} href={`/${locale}/app/schedule/makeups`}>
          {k.active}
        </Link>
        <Link className="link" aria-current={showAll ? 'page' : undefined} href={`/${locale}/app/schedule/makeups?show=all`}>
          {k.all}
        </Link>
      </nav>
      {reqs.length === 0 ? (
        <EmptyState title={k.none} />
      ) : (
        <ul className="space-y-3">
          {reqs.map((r) => {
            const options = future.filter((s) => s.branch_id === r.branch_id);
            return (
              <li key={r.id} className="space-y-3 rounded-[var(--radius-card)] border border-border p-4">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{nameOf(r.student_id)}</span>
                  <Badge tone={r.status === 'done' ? 'success' : r.status === 'scheduled' ? 'brand' : r.status === 'open' ? 'warning' : 'neutral'}>{k.statuses[r.status]}</Badge>
                </p>
                <p className="text-sm text-muted">
                  {k.missed}: {r.missed?.groups?.name ?? '—'}, {when(r.missed?.period)}
                  {r.makeup ? (
                    <>
                      {' '}
                      · {k.makeup}:{' '}
                      <Link className="link" href={`/${locale}/app/schedule/sessions/${r.makeup.id}`}>
                        {r.makeup.groups?.name ?? '—'}, {when(r.makeup.period)}
                      </Link>
                    </>
                  ) : null}
                  {r.note ? ` · ${r.note}` : ''}
                </p>
                {r.status === 'open' || r.status === 'scheduled' ? (
                  <div className="flex flex-wrap items-end gap-3">
                    {options.length ? (
                      <ActionForm action={makeupScheduleAction} submitLabel={k.schedule} pendingLabel={t.common.pending} messages={msg} className="flex flex-wrap items-end gap-3">
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="requestId" value={r.id} />
                        <SelectField name="sessionId" label={k.chooseSession} idPrefix={`mk-${r.id}`}>
                          {options.map((s) => (
                            <option key={s.id as string} value={s.id as string}>
                              {when(s.period as string)} · {(s.groups as unknown as { name: string } | null)?.name ?? '—'}
                            </option>
                          ))}
                        </SelectField>
                      </ActionForm>
                    ) : (
                      <p className="text-sm text-muted">{k.noSessions}</p>
                    )}
                    {r.status === 'scheduled' ? (
                      <ActionForm action={makeupResolveAction} submitLabel={k.done} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="requestId" value={r.id} />
                        <input type="hidden" name="status" value="done" />
                      </ActionForm>
                    ) : null}
                    <ActionForm action={makeupResolveAction} submitLabel={k.cancel} pendingLabel={t.common.pending} messages={msg} variant="secondary" fieldLabels={{ note: k.reason }} className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="requestId" value={r.id} />
                      <input type="hidden" name="status" value="cancelled" />
                      <Field name="note" label={k.reason} maxLength={500} idPrefix={`mc-${r.id}`} />
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePage>
  );
}
