import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { acknowledgeAnnouncementAction, archiveAnnouncementAction } from '@/server/management/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function AnnouncementPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/announcements/${id}`);
  const t = getDictionary(locale);
  const a = t.mgmt.ann;
  const msg = authMessages(t);
  const db = await createUserClient();
  // RLS: объявление видят получатели и те, кто публикует в его охвате.
  const { data: ann } = await db
    .from('announcements')
    .select('id, organization_id, branch_id, title, body, audience, requires_ack, status, recipient_count, published_by, published_at, organizations(default_timezone), branches(name)')
    .eq('id', id)
    .maybeSingle();
  if (!ann) notFound();
  const org = ann.organization_id as string;
  const branch = (ann.branch_id as string | null) ?? null;
  const m = ctx.memberships;
  const manages = can(m, 'announcement.publish', org, branch);
  const canArchive = manages && ann.status === 'published' && (ann.published_by === ctx.user.id || can(m, 'announcement.publish', org, null));
  const tz = (ann.organizations as unknown as { default_timezone: string } | null)?.default_timezone ?? DEFAULT_TIMEZONE;

  const { data: own } = await db.from('announcement_recipients').select('read_at, acknowledged_at').eq('announcement_id', id).eq('profile_id', ctx.user.id).maybeSingle();
  // Открыл — значит прочитал (ссылки на страницу не предзагружаются).
  if (own && !own.read_at) await db.rpc('announcement_read', { p_id: id, p_ack: false });

  const [{ data: receipts }, { data: statsData }] = manages
    ? await Promise.all([
        db.from('announcement_recipients').select('profile_id, read_at, acknowledged_at').eq('announcement_id', id).order('read_at', { ascending: false, nullsFirst: false }).limit(500),
        db.rpc('announcement_stats', { p_ids: [id] }),
      ])
    : [{ data: [] as { profile_id: string; read_at: string | null; acknowledged_at: string | null }[] }, { data: {} }];
  const stats = ((statsData ?? {}) as Record<string, { recipients: number; read: number; acknowledged: number }>)[id];
  const ids = [ann.published_by as string, ...(receipts ?? []).map((r) => r.profile_id as string)];
  const { data: people } = await db.from('profiles').select('id, full_name').in('id', [...new Set(ids)]);
  const nameOf = (pid: string) => ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—';
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="announcementId" value={id} />
    </>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={ann.title as string}>
      <p>
        <Link className="link" href={`/${locale}/app/announcements`}>
          {a.back}
        </Link>
      </p>
      <Card>
        <p className="mb-3 flex flex-wrap gap-x-4 text-sm text-muted">
          <span>
            {a.by}: {nameOf(ann.published_by as string)}
          </span>
          <span>{formatShortDateTime(locale, ann.published_at as string, tz)}</span>
          <span>{(ann.branches as unknown as { name: string } | null)?.name ?? a.allBranches}</span>
          {ann.status === 'archived' ? <Badge>{a.archived}</Badge> : null}
        </p>
        <p className="whitespace-pre-wrap">{ann.body as string}</p>
      </Card>

      {own && ann.requires_ack ? (
        own.acknowledged_at ? (
          <p>
            <Badge tone="success">{a.acknowledged}</Badge>
          </p>
        ) : (
          <ActionForm action={acknowledgeAnnouncementAction} submitLabel={a.ack} pendingLabel={t.common.pending} messages={msg}>
            {hidden}
          </ActionForm>
        )
      ) : null}

      {manages ? (
        <section aria-labelledby="rc-h" className="space-y-3">
          <h2 id="rc-h" className="text-xl font-bold">
            {a.recipients}
          </h2>
          {stats ? (
            <p className="text-sm">
              {fmt(a.stats, { read: String(stats.read), total: String(stats.recipients) })}
              {ann.requires_ack ? `; ${fmt(a.ackStats, { ack: String(stats.acknowledged), total: String(stats.recipients) })}` : ''}
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-4">
                    {a.name}
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    {a.readAt}
                  </th>
                  {ann.requires_ack ? (
                    <th scope="col" className="py-2">
                      {a.ackAt}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {(receipts ?? []).map((r) => (
                  <tr key={r.profile_id as string} className="border-b border-border">
                    <td className="py-2 pr-4">{nameOf(r.profile_id as string)}</td>
                    <td className="py-2 pr-4">{r.read_at ? formatShortDateTime(locale, r.read_at as string, tz) : '—'}</td>
                    {ann.requires_ack ? <td className="py-2">{r.acknowledged_at ? formatShortDateTime(locale, r.acknowledged_at as string, tz) : '—'}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canArchive ? (
            <ActionForm action={archiveAnnouncementAction} submitLabel={a.archive} pendingLabel={t.common.pending} messages={msg} variant="secondary">
              {hidden}
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </WorkspacePage>
  );
}
