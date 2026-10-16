import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { LoginForm } from '@/features/auth/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { safeNext } from '@/lib/auth/safe-redirect';
import { getCurrentUser } from '@/server/auth/session';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string; error?: string }> };

export default async function LoginPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const { next, error } = await searchParams;
  const target = safeNext(next, locale);
  if (await getCurrentUser()) redirect(target);

  const t = getDictionary(locale);
  const linkError = error === 'link_invalid' || error === 'unavailable' ? t.auth.errors[error] : null;
  return (
    <AuthShell
      locale={locale}
      t={t}
      title={t.auth.loginTitle}
      footer={
        <>
          <p>
            <Link className="underline" href={`/${locale}/forgot-password`}>
              {t.auth.forgotLink}
            </Link>
          </p>
          <p>
            {t.auth.noAccount}{' '}
            <Link className="underline" href={`/${locale}/register`}>
              {t.nav.register}
            </Link>
          </p>
        </>
      }
    >
      {linkError ? (
        <p role="alert" className="mb-4 rounded-md border border-danger-700 bg-danger-50 px-3 py-2 text-sm text-danger-700">
          {linkError}
        </p>
      ) : null}
      <LoginForm locale={locale} t={t.auth} pending={t.common.pending} next={target} />
    </AuthShell>
  );
}
