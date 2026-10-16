import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { markNotificationsReadAction } from '@/server/schedule/actions';
import { myNotifications, type Notification } from '@/server/schedule/queries';

export default async function NotificationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/notifications`);
  const t = getDictionary(locale);
  const s = t.schedule;
  const items = await myNotifications();
  const unread = (items ?? []).filter((n) => !n.readAt).length;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={s.notificationsTitle} unavailable={items === null}>
      {unread > 0 ? (
        <ActionForm action={markNotificationsReadAction} submitLabel={s.markAllRead} pendingLabel={t.common.pending} messages={authMessages(t)} variant="secondary">
          <input type="hidden" name="locale" value={locale} />
        </ActionForm>
      ) : null}
      {(items ?? []).length === 0 ? (
        <EmptyState title={s.noNotifications} />
      ) : (
        <ul className="space-y-2">
          {(items ?? []).map((n) => (
            <li key={n.id} className="space-y-1 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <p>
                {!n.readAt ? (
                  <>
                    <Badge tone="brand">{s.unread}</Badge>{' '}
                  </>
                ) : null}
                {describe(n, locale, t)}
              </p>
              {typeof n.payload.note === 'string' && n.payload.note ? <p className="text-sm">{fmt(s.notifNote, { note: n.payload.note })}</p> : null}
              <p className="flex flex-wrap gap-3 text-sm text-muted">
                <span>{formatShortDateTime(locale, n.createdAt, tzOf(n))}</span>
                {typeof n.payload.sessionId === 'string' ? (
                  <Link className="link" href={`/${locale}/app/schedule/sessions/${n.payload.sessionId}`}>
                    {s.open}
                  </Link>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}

const tzOf = (n: Notification) => (typeof n.payload.timezone === 'string' ? n.payload.timezone : DEFAULT_TIMEZONE);

/** Текст уведомления строится из данных события на языке читателя, а не хранится готовой строкой. */
function describe(n: Notification, locale: Locale, t: Dictionary): string {
  const s = t.schedule;
  const p = n.payload;
  const tz = tzOf(n);
  const when = (v: unknown) => (typeof v === 'string' ? formatShortDateTime(locale, v, tz) : '—');
  const kinds = Array.isArray(p.kinds) ? p.kinds.map((k) => s.changeKinds[k as 'rescheduled'] ?? String(k)).join(', ') : '';
  return fmt(s.notif[n.kind], { group: typeof p.groupName === 'string' ? p.groupName : '—', old: when(p.oldStart), new: when(p.newStart), kinds });
}
