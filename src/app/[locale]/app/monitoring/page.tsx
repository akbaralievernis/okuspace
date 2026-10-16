import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { resolveAlertAction, runCheckAction } from '@/server/monitoring/actions';
import { createUserClient } from '@/server/supabase/server';

type Util = { classroomId: string; classroom: string; branch: string; capacity: number; scheduledHours: number; occupiedHours: number; avgDuringSessions: number | null; hasCounter: boolean };

export default async function MonitoringPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/monitoring`);
  const t = getDictionary(locale);
  const mt = t.monitoring;
  const msg = authMessages(t);
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const viewer = m.find((x) => can(m, 'monitoring.view', x.organizationId, x.branchId));
  const org = viewer?.organizationId;
  const manager = m.some((x) => can(m, 'monitoring.manage', x.organizationId, x.branchId));
  const db = await createUserClient();
  const now = new Date();
  const [{ data: policy }, { data: alerts }, { data: devices }, util] = org
    ? await Promise.all([
        db.from('monitoring_policies').select('enabled').eq('organization_id', org).maybeSingle(),
        db.from('monitoring_alerts').select('id, kind, details, status, session_id, created_at, resolution_note').order('created_at', { ascending: false }).limit(50),
        db.from('camera_devices').select('id, name, kind, status, classroom_id, last_seen_at, classrooms(name)').order('name'),
        db.rpc('room_utilization', { p_org: org, p_from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), p_to: now.toISOString() }),
      ])
    : [{ data: null }, { data: [] }, { data: [] }, { data: [] }];
  const open = (alerts ?? []).filter((a) => a.status === 'open');

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={mt.title} lead={mt.lead} allowed={Boolean(viewer)}>
      {manager ? (
        <p>
          <Link className="link" href={`/${locale}/app/monitoring/settings`}>
            {mt.settingsLink}
          </Link>
        </p>
      ) : null}
      {!policy?.enabled ? <Notice tone="warning">{mt.disabled}</Notice> : null}
      <Notice tone="info" title={mt.levelsTitle}>
        <p>{mt.levels}</p>
        <p className="mt-2">{mt.accuracyNote}</p>
      </Notice>

      <section aria-labelledby="q-h" className="space-y-3">
        <h2 id="q-h" className="text-xl font-bold">
          {mt.alertsTitle}
        </h2>
        <p className="text-sm text-muted">{mt.alertHint}</p>
        {org && policy?.enabled ? (
          <ActionForm action={runCheckAction} submitLabel={mt.runCheck} pendingLabel={t.common.pending} messages={msg} variant="secondary">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
          </ActionForm>
        ) : null}
        {open.length === 0 ? <EmptyState title={mt.noAlerts} /> : null}
        <ul className="space-y-3">
          {open.map((a) => {
            const d = a.details as Record<string, number>;
            return (
              <li key={a.id as string} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">{mt.statuses.open}</Badge>
                  <strong>{mt.alertKinds[a.kind as 'group_absent']}</strong>
                  <span className="text-sm text-muted">{formatShortDateTime(locale, a.created_at as string, DEFAULT_TIMEZONE)}</span>
                </p>
                <p className="text-sm">{fmt(mt.alertFacts, { maxCount: d.maxCount ?? '—', snapshots: d.snapshots ?? '—', enrolled: d.enrolled ?? '—', marked: d.marked ?? '—' })}</p>
                {a.session_id ? (
                  <Link className="link text-sm" href={`/${locale}/app/schedule/sessions/${a.session_id as string}`}>
                    {mt.openSession}
                  </Link>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['confirmed', 'dismissed'] as const).map((status) => (
                    <ActionForm key={status} action={resolveAlertAction} submitLabel={status === 'confirmed' ? mt.confirm : mt.dismiss} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ note: mt.resolution }} variant={status === 'confirmed' ? 'primary' : 'secondary'} className="space-y-2">
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="alertId" value={a.id as string} />
                      <input type="hidden" name="status" value={status} />
                      <Field name="note" label={mt.resolution} required minLength={3} maxLength={1000} idPrefix={`al-${status}-${a.id as string}`} />
                    </ActionForm>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="u-h" className="space-y-3">
        <h2 id="u-h" className="text-xl font-bold">
          {mt.utilizationTitle}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{mt.utilizationTitle}</caption>
            <thead>
              <tr className="border-b border-border text-left">
                {[mt.classroom, mt.branch, mt.capacity, mt.scheduledHours, mt.occupiedHours, mt.avgDuringSessions].map((h) => (
                  <th key={h} scope="col" className="px-2 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {((util.data ?? []) as Util[]).map((u) => (
                <tr key={u.classroomId} className="border-b border-border">
                  <th scope="row" className="px-2 py-2 text-left">
                    {u.hasCounter ? (
                      <Link className="link" href={`/${locale}/app/monitoring/rooms/${u.classroomId}`}>
                        {u.classroom}
                      </Link>
                    ) : (
                      u.classroom
                    )}
                  </th>
                  <td className="px-2 py-2">{u.branch}</td>
                  <td className="px-2 py-2 tabular-nums">{u.capacity}</td>
                  <td className="px-2 py-2 tabular-nums">{u.scheduledHours}</td>
                  <td className="px-2 py-2 tabular-nums">{u.hasCounter ? u.occupiedHours : mt.noCounter}</td>
                  <td className="px-2 py-2 tabular-nums">{u.avgDuringSessions ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted">{mt.accessLogged}</p>
      </section>

      <section aria-labelledby="d-h" className="space-y-2">
        <h2 id="d-h" className="text-xl font-bold">
          {mt.devicesTitle}
        </h2>
        <ul className="space-y-1">
          {(devices ?? []).map((d) => {
            const room = (Array.isArray(d.classrooms) ? d.classrooms[0] : d.classrooms) as { name: string } | undefined;
            return (
              <li key={d.id as string} className="flex flex-wrap justify-between gap-2 border-b border-border py-1">
                <span>
                  {d.name as string} · {mt.kinds[d.kind as 'occupancy_counter']} · {room?.name ?? mt.unassigned}
                </span>
                <span className="flex items-center gap-2 text-sm">
                  <Badge tone={d.status === 'active' ? 'success' : 'neutral'}>{mt.deviceStatuses[d.status as 'active']}</Badge>
                  {mt.lastSeen}: {d.last_seen_at ? formatShortDateTime(locale, d.last_seen_at as string, DEFAULT_TIMEZONE) : mt.never}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </WorkspacePage>
  );
}
