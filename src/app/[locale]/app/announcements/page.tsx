import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckboxField, SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { publishAnnouncementAction } from '@/server/management/actions';
import { AUDIENCE_ROLES } from '@/server/management/constants';
import { createUserClient } from '@/server/supabase/server';

interface Ann {
  id: string;
  organization_id: string;
  branch_id: string | null;
  title: string;
  requires_ack: boolean;
  status: string;
  published_at: string;
  published_by: string;
}
type Stats = Record<string, { recipients: number; read: number; acknowledged: number }>;

export default async function AnnouncementsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/announcements`);
  const t = getDictionary(locale);
  const a = t.mgmt.ann;
  const msg = authMessages(t);
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const orgs = [...new Set(m.map((x) => x.organizationId))];
  const publishOrgs = orgs.filter((org) => m.some((x) => x.organizationId === org && can(m, 'announcement.publish', org, x.branchId)));
  const db = await createUserClient();

  const [{ data: received }, { data: published }, { data: branches }] = await Promise.all([
    db
      .from('announcement_recipients')
      .select('read_at, acknowledged_at, announcements(id, organization_id, branch_id, title, requires_ack, status, published_at, published_by)')
      .eq('profile_id', ctx.user.id)
      .order('announcement_id', { ascending: false })
      .limit(100),
    publishOrgs.length
      ? db.from('announcements').select('id, organization_id, branch_id, title, requires_ack, status, published_at, published_by').in('organization_id', publishOrgs).order('published_at', { ascending: false }).limit(100)
      : Promise.resolve({ data: [] as Ann[] }),
    orgs.length ? db.from('branches').select('id, organization_id, name').in('organization_id', orgs).eq('status', 'active').order('name') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const inbox = (received ?? [])
    .map((r) => ({ read: Boolean(r.read_at), ack: Boolean(r.acknowledged_at), ann: r.announcements as unknown as Ann | null }))
    .filter((r): r is { read: boolean; ack: boolean; ann: Ann } => Boolean(r.ann) && r.ann!.status === 'published')
    .sort((x, y) => y.ann.published_at.localeCompare(x.ann.published_at));
  const mine = ((published ?? []) as Ann[]).filter((x) => can(m, 'announcement.publish', x.organization_id, x.branch_id));
  const { data: statsData } = mine.length ? await db.rpc('announcement_stats', { p_ids: mine.map((x) => x.id) }) : { data: {} };
  const stats = (statsData ?? {}) as Stats;
  const branchName = (id: string | null) => (id ? ((branches ?? []).find((b) => b.id === id)?.name as string) ?? '—' : a.allBranches);
  const org = publishOrgs[0];
  const orgWide = org ? can(m, 'announcement.publish', org, null) : false;
  const targets = (branches ?? []).filter((b) => b.organization_id === org && can(m, 'announcement.publish', org!, b.id as string));
  const tz = DEFAULT_TIMEZONE;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={a.title} allowed={orgs.length > 0}>
      <section aria-labelledby="in-h" className="space-y-3">
        <h2 id="in-h" className="text-xl font-bold">
          {a.received}
        </h2>
        {inbox.length === 0 ? (
          <EmptyState title={a.none} />
        ) : (
          <ul className="space-y-2">
            {inbox.map(({ ann, read, ack }) => (
              <li key={ann.id} className="rounded-[var(--radius-control)] border border-border px-3 py-2">
                <p className="flex flex-wrap items-center gap-2">
                  {!read ? <Badge tone="brand">{a.unread}</Badge> : null}
                  <Link className="link font-semibold" prefetch={false} href={`/${locale}/app/announcements/${ann.id}`}>
                    {ann.title}
                  </Link>
                  {ann.requires_ack ? <Badge tone={ack ? 'success' : 'warning'}>{ack ? a.acknowledged : a.ackRequired}</Badge> : null}
                </p>
                <p className="text-sm text-muted">{formatShortDateTime(locale, ann.published_at, tz)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {publishOrgs.length ? (
        <section aria-labelledby="pub-h" className="space-y-3">
          <h2 id="pub-h" className="text-xl font-bold">
            {a.published}
          </h2>
          {mine.length === 0 ? (
            <EmptyState title={a.none} />
          ) : (
            <ul className="space-y-2">
              {mine.map((ann) => {
                const s = stats[ann.id];
                return (
                  <li key={ann.id} className="rounded-[var(--radius-control)] border border-border px-3 py-2">
                    <p className="flex flex-wrap items-center gap-2">
                      <Link className="link font-semibold" prefetch={false} href={`/${locale}/app/announcements/${ann.id}`}>
                        {ann.title}
                      </Link>
                      {ann.status === 'archived' ? <Badge>{a.archived}</Badge> : null}
                    </p>
                    <p className="flex flex-wrap gap-x-4 text-sm text-muted">
                      <span>{branchName(ann.branch_id)}</span>
                      <span>{formatShortDateTime(locale, ann.published_at, tz)}</span>
                      {s ? <span>{fmt(a.stats, { read: String(s.read), total: String(s.recipients) })}</span> : null}
                      {s && ann.requires_ack ? <span>{fmt(a.ackStats, { ack: String(s.acknowledged), total: String(s.recipients) })}</span> : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {org && (orgWide || targets.length) ? (
        <Card>
          <h2 className="mb-3 text-xl font-bold">{a.newTitle}</h2>
          <p className="mb-3 text-sm text-muted">{a.publishHint}</p>
          <ActionForm
            action={publishAnnouncementAction}
            submitLabel={a.publish}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ title: a.fTitle, body: a.fBody, audience: a.fAudience }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
            <SelectField name="branchId" label={a.fBranch} idPrefix="na">
              {orgWide ? <option value="">{a.allBranches}</option> : null}
              {targets.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
            </SelectField>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{a.fAudience}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {AUDIENCE_ROLES.map((r) => (
                  <label key={r} className="flex items-start gap-3 text-sm">
                    <input type="checkbox" name="audience" value={r} className="mt-0.5 size-5 shrink-0 accent-brand-700" />
                    <span>{t.roles[r]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field name="title" label={a.fTitle} required minLength={2} maxLength={200} idPrefix="na" />
            <TextareaField name="body" label={a.fBody} required maxLength={10000} idPrefix="na" />
            <CheckboxField name="requiresAck" label={a.fAck} idPrefix="na" />
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}
