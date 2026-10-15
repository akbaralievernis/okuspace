import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);

  return (
    <>
      <header className="mx-auto flex max-w-5xl items-center justify-end px-4 py-4">
        <Suspense>
          <LanguageSwitcher current={locale} label={t.languageSwitcher.label} />
        </Suspense>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-16">
        <p className="text-sm font-medium uppercase tracking-wide text-brand-700">{t.home.status}</p>
        <h1 className="mt-3 text-4xl font-bold sm:text-5xl">{t.home.heading}</h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">{t.home.description}</p>
      </main>
    </>
  );
}
