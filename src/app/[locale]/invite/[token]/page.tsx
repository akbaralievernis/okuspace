import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { AcceptInvitationForm } from '@/features/members/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getCurrentUser } from '@/server/auth/session';

export const metadata = { referrer: 'no-referrer' as const }; // токен в URL не уходит через Referer

export default async function InvitePage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token } = await params;
  if (!isLocale(locale) || !/^[A-Za-z0-9_-]{32,200}$/.test(token)) notFound();
  const t = getDictionary(locale);
  const user = await getCurrentUser();
  const here = encodeURIComponent(`/${locale}/invite/${token}`);

  return (
    <AuthShell locale={locale} t={t} title={t.app.invite.title}>
      {user ? (
        <AcceptInvitationForm locale={locale} token={token} t={t} pending={t.common.pending} />
      ) : (
        <div className="space-y-4">
          <p>{t.app.invite.intro}</p>
          <p className="flex flex-wrap gap-3">
            <Link className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 font-medium text-white" href={`/${locale}/login?next=${here}`}>
              {t.nav.signIn}
            </Link>
            <Link className="inline-flex min-h-11 items-center rounded-md border border-gray-400 px-4" href={`/${locale}/register`}>
              {t.nav.register}
            </Link>
          </p>
        </div>
      )}
    </AuthShell>
  );
}
