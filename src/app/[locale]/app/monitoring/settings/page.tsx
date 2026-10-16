import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckboxField, SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { addDeviceAction, rotateDeviceTokenAction, savePolicyAction, updateDeviceAction } from '@/server/monitoring/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function MonitoringSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/monitoring/settings`);
  const t = getDictionary(locale);
  const mt = t.monitoring;
  const msg = authMessages(t);
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const managerOf = m.find((x) => can(m, 'monitoring.manage', x.organizationId, x.branchId));
  const org = managerOf?.organizationId;
  const orgLevel = org ? can(m, 'monitoring.manage', org, null) : false;
  const db = await createUserClient();
  const [{ data: policy }, { data: devices }, { data: branches }, { data: rooms }, { data: log }] = org
    ? await Promise.all([
        db.from('monitoring_policies').select('*').eq('organization_id', org).maybeSingle(),
        db.from('camera_devices').select('id, branch_id, name, kind, status, classroom_id, last_seen_at').order('name'),
        db.from('branches').select('id, name').eq('organization_id', org).order('name'),
        db.from('classrooms').select('id, branch_id, name').eq('organization_id', org).eq('status', 'active').order('name'),
        db.from('monitoring_access_log').select('id, actor_id, action, target, created_at').order('id', { ascending: false }).limit(50),
      ])
    : [{ data: null }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const manageable = (branches ?? []).filter((b) => can(m, 'monitoring.manage', org!, b.id as string));
  const actorIds = [...new Set((log ?? []).map((l) => l.actor_id as string))];
  const { data: names } = actorIds.length ? await db.from('profiles').select('id, full_name').in('id', actorIds) : { data: [] };
  const nameOf = (id: string) => ((names ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const checklist = [
    [mt.check1, Boolean(policy?.purpose)],
    [mt.check2, Boolean(policy?.legal_basis)],
    [mt.check3, Boolean(policy?.notice_published_at)],
    [mt.check4, Boolean(policy?.legal_reviewed_at)],
    [mt.check5, null],
  ] as const;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={mt.settingsTitle} allowed={Boolean(org)}>
      <p>
        <Link className="link" href={`/${locale}/app/monitoring`}>
          {mt.title}
        </Link>
      </p>
      <section aria-labelledby="cl-h" className="space-y-2">
        <h2 id="cl-h" className="text-xl font-bold">
          {mt.checklistTitle}
        </h2>
        <ul className="space-y-1">
          {checklist.map(([label, ok]) => (
            <li key={label} className="flex items-center gap-2">
              <Badge tone={ok === true ? 'success' : 'warning'}>{ok === true ? '✓' : ok === false ? '✗' : '?'}</Badge> {label}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">{mt.accuracyNote}</p>
      </section>

      {orgLevel ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{mt.settingsTitle}</h2>
          <ActionForm
            action={savePolicyAction}
            submitLabel={mt.save}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ enabled: mt.enabled, purpose: mt.purpose, legalBasis: mt.legalBasis, noticeText: mt.noticeText, legalReviewer: mt.legalReviewer }}
            className="space-y-4"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org!} />
            <TextareaField name="purpose" label={mt.purpose} maxLength={1000} rows={2} defaultValue={(policy?.purpose as string | null) ?? ''} idPrefix="mp" />
            <TextareaField name="legalBasis" label={mt.legalBasis} maxLength={1000} rows={2} defaultValue={(policy?.legal_basis as string | null) ?? ''} idPrefix="mp" />
            <TextareaField name="noticeText" label={mt.noticeText} maxLength={4000} rows={4} defaultValue={(policy?.notice_text as string | null) ?? ''} idPrefix="mp" />
            <CheckboxField name="publishNotice" label={mt.publishNotice} defaultChecked={Boolean(policy?.notice_published_at)} idPrefix="mp" />
            <Field name="legalReviewer" label={mt.legalReviewer} maxLength={200} defaultValue={(policy?.legal_reviewer as string | null) ?? ''} idPrefix="mp" />
            <CheckboxField name="legalReviewed" label={mt.legalReviewed} defaultChecked={Boolean(policy?.legal_reviewed_at)} idPrefix="mp" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="dataRetentionDays" label={mt.dataRetention} type="number" min={1} max={90} defaultValue={Number(policy?.data_retention_days ?? 30)} idPrefix="mp" />
              <Field name="alertRetentionDays" label={mt.alertRetention} type="number" min={30} max={365} defaultValue={Number(policy?.alert_retention_days ?? 180)} idPrefix="mp" />
            </div>
            <CheckboxField name="enabled" label={mt.enabled} defaultChecked={Boolean(policy?.enabled)} idPrefix="mp" />
          </ActionForm>
        </Card>
      ) : (
        <Notice tone="info">{policy?.enabled ? mt.enabled : mt.disabled}</Notice>
      )}

      <section aria-labelledby="dv-h" className="space-y-3">
        <h2 id="dv-h" className="text-xl font-bold">
          {mt.devicesTitle}
        </h2>
        <ul className="space-y-3">
          {(devices ?? [])
            .filter((d) => can(m, 'monitoring.manage', org!, d.branch_id as string))
            .map((d) => (
              <li key={d.id as string} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
                <p className="flex flex-wrap items-center gap-2">
                  <strong>{d.name as string}</strong> · {mt.kinds[d.kind as 'occupancy_counter']}
                  <Badge tone={d.status === 'active' ? 'success' : 'neutral'}>{mt.deviceStatuses[d.status as 'active']}</Badge>
                  <span className="text-sm text-muted">
                    {mt.lastSeen}: {d.last_seen_at ? formatShortDateTime(locale, d.last_seen_at as string, DEFAULT_TIMEZONE) : mt.never}
                  </span>
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <ActionForm action={updateDeviceAction} submitLabel={mt.save} pendingLabel={t.common.pending} messages={msg} variant="secondary" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="deviceId" value={d.id as string} />
                    <SelectField name="classroomId" label={mt.classroom} defaultValue={(d.classroom_id as string | null) ?? ''} idPrefix={`dv-${d.id as string}`}>
                      <option value="">{mt.unassigned}</option>
                      {(rooms ?? [])
                        .filter((r) => r.branch_id === d.branch_id)
                        .map((r) => (
                          <option key={r.id as string} value={r.id as string}>
                            {r.name as string}
                          </option>
                        ))}
                    </SelectField>
                    <SelectField name="status" label={mt.status} defaultValue={d.status as string} idPrefix={`dv-${d.id as string}`}>
                      <option value="active">{mt.deviceStatuses.active}</option>
                      <option value="disabled">{mt.deviceStatuses.disabled}</option>
                    </SelectField>
                  </ActionForm>
                  <ActionForm action={rotateDeviceTokenAction} submitLabel={mt.rotate} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="deviceId" value={d.id as string} />
                  </ActionForm>
                </div>
              </li>
            ))}
        </ul>
        {manageable.length ? (
          <ActionForm action={addDeviceAction} submitLabel={mt.addDevice} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ name: mt.deviceName }} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org!} />
            <Field name="name" label={mt.deviceName} required maxLength={100} idPrefix="nd" />
            <SelectField name="kind" label={mt.kind} idPrefix="nd">
              <option value="occupancy_counter">{mt.kinds.occupancy_counter}</option>
              <option value="entrance_counter">{mt.kinds.entrance_counter}</option>
            </SelectField>
            <SelectField name="branchId" label={mt.branch} idPrefix="nd">
              {manageable.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
            </SelectField>
            <SelectField name="classroomId" label={mt.classroom} idPrefix="nd">
              <option value="">{mt.unassigned}</option>
              {(rooms ?? [])
                .filter((r) => manageable.some((b) => b.id === r.branch_id))
                .map((r) => (
                  <option key={r.id as string} value={r.id as string}>
                    {r.name as string}
                  </option>
                ))}
            </SelectField>
          </ActionForm>
        ) : null}
      </section>

      <section aria-labelledby="log-h" className="space-y-2">
        <h2 id="log-h" className="text-xl font-bold">
          {mt.accessLogTitle}
        </h2>
        <ul className="space-y-1 text-sm">
          {(log ?? []).map((l) => (
            <li key={String(l.id)}>
              {formatShortDateTime(locale, l.created_at as string, DEFAULT_TIMEZONE)} · {nameOf(l.actor_id as string)} · {mt.actions[l.action as 'view_room']}
              {l.target ? ` · ${l.target as string}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </WorkspacePage>
  );
}
