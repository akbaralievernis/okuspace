import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { Notice } from '@/components/ui/notice';
import { RegisterForm } from '@/features/auth/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getCurrentUser } from '@/server/auth/session';
import { getSite } from '@/server/public/site';

export default async function RegisterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  if (await getCurrentUser()) redirect(`/${locale}/app`);
  const t = getDictionary(locale);
  const site = await getSite();
  const open = site.ok && !!site.data?.legal.privacy && !!site.data.legal.terms;
  return (
    <AuthShell
      locale={locale}
      t={t}
      title={t.auth.registerTitle}
      footer={
        <p>
          {t.auth.haveAccount}{' '}
          <Link className="underline" href={`/${locale}/login`}>
            {t.nav.signIn}
          </Link>
        </p>
      }
    >
      <p className="mb-4 text-muted">{t.auth.registerIntro}</p>
      {open ? (
        <RegisterForm
          locale={locale}
          t={t.auth}
          pending={t.common.pending}
          documents={[
            { href: `/${locale}/legal/privacy`, label: t.site.legal.privacy },
            { href: `/${locale}/legal/terms`, label: t.site.legal.terms },
          ]}
        />
      ) : (
        <Notice tone="info">{site.ok ? t.site.registerClosed : t.site.unavailable}</Notice>
      )}
    </AuthShell>
  );
}
