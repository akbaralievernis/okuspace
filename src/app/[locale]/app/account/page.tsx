import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { SignOutOthersForm } from '@/features/members/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { can } from '@/server/authz/check';
import { requireAccess } from '@/server/auth/session';
import { mySecurityEvents, mySessions } from '@/server/queries/workspace';

export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/account`);
  const t = getDictionary(locale);
  const [sessions, events] = await Promise.all([mySessions(), mySecurityEvents(ctx.user.id)]);
  const showMembers = ctx.memberships.some((m) => can(ctx.memberships, 'member.read', m.organizationId, m.branchId));
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <>
      <AppHeader locale={locale} t={t} showMembers={showMembers} />
      <main id="main" className="mx-auto max-w-5xl space-y-10 px-4 py-8">
        <h1 className="text-2xl font-bold">{t.app.account.title}</h1>

        <section aria-labelledby="mfa-h" className="space-y-2">
          <h2 id="mfa-h" className="text-lg font-semibold">{t.app.account.mfaTitle}</h2>
          {ctx.user.aal === 'aal2' ? (
            <p>{t.app.account.mfaOn}</p>
          ) : (
            <p>
              {t.app.account.mfaOff}.{' '}
              <Link className="underline" href={`/${locale}/mfa?next=/${locale}/app/account`}>
                {t.app.account.mfaSetup}
              </Link>
            </p>
          )}
        </section>

        <section aria-labelledby="sessions-h" className="space-y-3">
          <h2 id="sessions-h" className="text-lg font-semibold">{t.app.account.sessionsTitle}</h2>
          {sessions === null ? (
            <p role="alert">{t.auth.errors.unavailable}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {sessions.map((s) => (
                <li key={s.id}>
                  {s.userAgent ?? t.app.account.unknownDevice} · {s.ip ?? '—'} · {dateFmt.format(new Date(s.updatedAt ?? s.createdAt))}
                  {s.isCurrent ? ` (${t.app.account.currentSession})` : ''}
                </li>
              ))}
            </ul>
          )}
          <SignOutOthersForm locale={locale} t={t} pending={t.common.pending} />
        </section>

        <section aria-labelledby="events-h" className="space-y-2">
          <h2 id="events-h" className="text-lg font-semibold">{t.app.account.eventsTitle}</h2>
          {events.length === 0 ? (
            <p>{t.app.account.noEvents}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {events.map((e) => (
                <li key={`${e.at}-${e.entity}`}>
                  {dateFmt.format(new Date(e.at))} — {fmt(t.app.account.event, { entity: e.entity, action: e.changed.length ? e.changed.join(', ') : e.action })}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
