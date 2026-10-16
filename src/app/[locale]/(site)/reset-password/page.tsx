import { notFound } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { ResetPasswordForm } from '@/features/auth/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireUser } from '@/server/auth/session';

/** Сюда приводит ссылка восстановления (через /auth/confirm, который создаёт сессию). */
export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireUser(locale, `/${locale}/reset-password`);
  const t = getDictionary(locale);
  return (
    <AuthShell locale={locale} t={t} title={t.auth.resetTitle}>
      <ResetPasswordForm locale={locale} t={t.auth} pending={t.common.pending} />
    </AuthShell>
  );
}
