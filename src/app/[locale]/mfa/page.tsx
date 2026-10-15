import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { MfaPanel } from '@/features/auth/forms';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { safeNext } from '@/lib/auth/safe-redirect';
import { buildDeps, requireUser } from '@/server/auth/session';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string }> };

export default async function MfaPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const next = safeNext((await searchParams).next, locale);
  const user = await requireUser(locale, `/${locale}/mfa`);
  if (user.aal === 'aal2') redirect(next);

  const t = getDictionary(locale);
  const status = await (await buildDeps()).gateway.mfaStatus();
  const factorId = status.ok ? (status.value.verifiedFactorIds[0] ?? null) : null;

  return (
    <AuthShell locale={locale} t={t} title={t.auth.mfaTitle}>
      <p className="mb-4">{t.auth.mfaRequired}</p>
      {status.ok ? (
        <MfaPanel locale={locale} t={t.auth} pending={t.common.pending} factorId={factorId} next={next} />
      ) : (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800">
          {t.auth.errors.unavailable}
        </p>
      )}
    </AuthShell>
  );
}
