import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { ForgotPasswordForm } from '@/features/auth/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

export default async function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  return (
    <AuthShell
      locale={locale}
      t={t}
      title={t.auth.forgotTitle}
      footer={
        <p>
          <Link className="underline" href={`/${locale}/login`}>
            {t.nav.signIn}
          </Link>
        </p>
      }
    >
      <p className="mb-4 text-muted">{t.auth.forgotIntro}</p>
      <ForgotPasswordForm locale={locale} t={t.auth} pending={t.common.pending} />
    </AuthShell>
  );
}
