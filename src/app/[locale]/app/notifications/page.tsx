import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { renderNotification } from '@/server/notifications/render';
import { markNotificationsReadAction } from '@/server/schedule/actions';
import { myNotifications } from '@/server/schedule/queries';

export default async function NotificationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/notifications`);
  const t = getDictionary(locale);
  const s = t.schedule;
  const n = t.notify;
  const items = await myNotifications();
  const unread = (items ?? []).filter((x) => !x.readAt).length;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={s.notificationsTitle} unavailable={items === null}>
      <p>
        <Link className="link" href={`/${locale}/app/notifications/settings`}>
          {n.settingsLink}
        </Link>
      </p>
      {unread > 0 ? (
        <ActionForm action={markNotificationsReadAction} submitLabel={s.markAllRead} pendingLabel={t.common.pending} messages={authMessages(t)} variant="secondary">
          <input type="hidden" name="locale" value={locale} />
        </ActionForm>
      ) : null}
      {(items ?? []).length === 0 ? (
        <EmptyState title={s.noNotifications} />
      ) : (
        <ul className="space-y-2">
          {(items ?? []).map((item) => {
            // Текст собирается на языке читателя из данных события (тот же, что уходит в email/Telegram).
            const r = renderNotification(item.kind, item.payload, locale);
            const tz = typeof item.payload.timezone === 'string' ? item.payload.timezone : DEFAULT_TIMEZONE;
            return (
              <li key={item.id} className="space-y-1 rounded-[var(--radius-control)] border border-border px-3 py-2">
                <p className="font-semibold">
                  {!item.readAt ? (
                    <>
                      <Badge tone="brand">{s.unread}</Badge>{' '}
                    </>
                  ) : null}
                  {r.title}
                </p>
                <p>{r.text}</p>
                <p className="flex flex-wrap gap-3 text-sm text-muted">
                  <span>{formatShortDateTime(locale, item.createdAt, tz)}</span>
                  {item.deliveries.map((d) => (
                    <span key={d.channel}>
                      {n.channelNames[d.channel as keyof typeof n.channelNames] ?? d.channel}: {n.delivery[d.status as keyof typeof n.delivery] ?? d.status}
                    </span>
                  ))}
                  <Link className="link" href={`/${locale}${r.path}`}>
                    {s.open}
                  </Link>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePage>
  );
}
