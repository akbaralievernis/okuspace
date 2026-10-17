import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { configuredChannels } from '@/server/notifications/channels';
import { savePreferencesAction, telegramCodeAction, unlinkTelegramAction } from '@/server/notifications/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function NotificationSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/notifications/settings`);
  const t = getDictionary(locale);
  const n = t.notify;
  const msg = authMessages(t);
  const db = await createUserClient();
  const [{ data: kinds }, { data: prefs }, { data: channels }] = await Promise.all([
    db.from('notification_kinds').select('code, optional, important').order('code'),
    db.from('notification_preferences').select('kind, channel, enabled').eq('profile_id', ctx.user.id),
    db.from('notification_channels').select('channel').eq('profile_id', ctx.user.id),
  ]);
  const configured = configuredChannels();
  const telegramLinked = (channels ?? []).some((c) => c.channel === 'telegram');
  // Без явной настройки: в кабинете — всё, во внешних каналах — только важное (как app.wants в БД).
  const value = (kind: string, channel: string, important: boolean) => {
    const p = (prefs ?? []).find((x) => x.kind === kind && x.channel === channel);
    if (p) return Boolean(p.enabled);
    return channel === 'in_app' ? true : important;
  };

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={n.settingsTitle}>
      <p>
        <Link className="link" href={`/${locale}/app/notifications`}>
          {t.schedule.notificationsTitle}
        </Link>
      </p>
      <p className="text-sm text-muted">{n.importantHint}</p>
      {!configured.email ? <Notice tone="info">{n.emailUnavailable}</Notice> : null}
      <ActionForm action={savePreferencesAction} submitLabel={n.save} pendingLabel={t.common.pending} messages={msg}>
        <input type="hidden" name="locale" value={locale} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <caption className="sr-only">{n.settingsTitle}</caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="px-2 py-2">
                  {n.kind}
                </th>
                <th scope="col" className="px-2 py-2">
                  {n.inApp}
                </th>
                <th scope="col" className="px-2 py-2">
                  {n.email}
                </th>
                <th scope="col" className="px-2 py-2">
                  {n.telegram}
                </th>
              </tr>
            </thead>
            <tbody>
              {(kinds ?? []).map((k) => {
                const code = k.code as keyof typeof n.kinds;
                const label = n.kinds[code] ?? String(k.code);
                return (
                  <tr key={k.code as string} className="border-b border-border">
                    <th scope="row" className="px-2 py-2 text-left font-normal">
                      {label}
                    </th>
                    {(['in_app', 'email', 'telegram'] as const).map((ch) => {
                      const locked = ch === 'in_app' && !k.optional;
                      const id = `pref-${k.code as string}-${ch}`;
                      return (
                        <td key={ch} className="px-2 py-2">
                          <label htmlFor={id} className="sr-only">
                            {label}: {ch === 'in_app' ? n.inApp : ch === 'email' ? n.email : n.telegram}
                          </label>
                          <input
                            id={id}
                            type="checkbox"
                            name={`pref:${k.code as string}:${ch}`}
                            defaultChecked={value(k.code as string, ch, Boolean(k.important))}
                            disabled={locked}
                            className="size-5 accent-brand-700"
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ActionForm>

      <section aria-labelledby="tg-h" className="space-y-3">
        <h2 id="tg-h" className="text-xl font-bold">
          {n.telegramTitle}
        </h2>
        {!configured.telegram ? (
          <Notice tone="info">{n.telegramUnavailable}</Notice>
        ) : telegramLinked ? (
          <>
            <p>{n.telegramConnected}</p>
            <ActionForm action={unlinkTelegramAction} submitLabel={n.telegramDisconnect} pendingLabel={t.common.pending} messages={msg} variant="secondary">
              <input type="hidden" name="locale" value={locale} />
            </ActionForm>
          </>
        ) : (
          <>
            <p>{n.telegramNotConnected}</p>
            <ActionForm action={telegramCodeAction} submitLabel={n.telegramConnect} pendingLabel={t.common.pending} messages={msg} variant="secondary">
              <input type="hidden" name="locale" value={locale} />
            </ActionForm>
          </>
        )}
      </section>
    </WorkspacePage>
  );
}
