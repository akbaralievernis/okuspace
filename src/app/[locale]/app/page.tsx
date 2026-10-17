import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppHeader, appNav } from '@/components/app-header';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { visibleMemberships } from '@/server/queries/workspace';
import { createUserClient } from '@/server/supabase/server';

export default async function WorkspacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app`);
  const t = getDictionary(locale);
  const mine = await visibleMemberships({ profileId: ctx.user.id });
  // Уведомление о мониторинге аудиторий — всем участникам школы, где он включён.
  const db = await createUserClient();
  const [{ data: monitored }, { count: openTasks }, { data: pendingAck }] = await Promise.all([
    db.from('monitoring_policies').select('organization_id').eq('enabled', true).not('notice_published_at', 'is', null),
    db.from('staff_tasks').select('id', { count: 'exact', head: true }).eq('assignee_id', ctx.user.id).in('status', ['open', 'in_progress']),
    db.from('announcement_recipients').select('announcement_id, announcements!inner(requires_ack, status)').eq('profile_id', ctx.user.id).is('acknowledged_at', null)
      .eq('announcements.requires_ack', true).eq('announcements.status', 'published').limit(50),
  ]);
  const toAck = (pendingAck ?? []).length;

  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-bold">{t.app.title}</h1>
        <p className="mt-1 text-muted">{fmt(t.app.greeting, { email: ctx.user.email ?? '' })}</p>
        {(monitored ?? []).length ? (
          <p className="mt-4 rounded-[var(--radius-control)] border-l-4 border-brand-700 bg-surface-muted px-4 py-3 text-sm">
            <Link className="link" href={`/${locale}/app/monitoring/notice`}>
              {t.monitoring.noticeOpen}
            </Link>
          </p>
        ) : null}

        {(openTasks ?? 0) > 0 || toAck > 0 ? (
          <ul className="mt-4 space-y-1 rounded-[var(--radius-control)] border-l-4 border-brand-700 bg-surface-muted px-4 py-3 text-sm">
            {(openTasks ?? 0) > 0 ? (
              <li>
                <Link className="link" href={`/${locale}/app/tasks`}>
                  {fmt(t.mgmt.homeTasks, { n: String(openTasks) })}
                </Link>
              </li>
            ) : null}
            {toAck > 0 ? (
              <li>
                <Link className="link" href={`/${locale}/app/announcements`}>
                  {fmt(t.mgmt.homeAck, { n: String(toAck) })}
                </Link>
              </li>
            ) : null}
          </ul>
        ) : null}

        <h2 className="mt-8 text-lg font-semibold">{t.app.membershipsTitle}</h2>
        {mine.filter((m) => m.status === 'active').length === 0 ? (
          <p className="mt-2">{t.app.noMemberships}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-4">{t.app.organization}</th>
                  <th scope="col" className="py-2 pr-4">{t.app.branch}</th>
                  <th scope="col" className="py-2">{t.app.role}</th>
                </tr>
              </thead>
              <tbody>
                {mine
                  .filter((m) => m.status === 'active')
                  .map((m) => (
                    <tr key={m.id} className="border-b border-border">
                      <td className="py-2 pr-4">{m.organizationName}</td>
                      <td className="py-2 pr-4">{m.branchName ?? t.app.wholeOrganization}</td>
                      <td className="py-2">{t.roles[m.role]}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
