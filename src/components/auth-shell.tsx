import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';

/** Каркас страниц входа/регистрации: заголовок, переключатель языка, карточка. */
export function AuthShell({ locale, t, title, children, footer }: { locale: Locale; t: Dictionary; title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
        <Link href={`/${locale}`} className="text-lg font-bold">
          Okuspace
        </Link>
        <Suspense>
          <LanguageSwitcher current={locale} label={t.languageSwitcher.label} />
        </Suspense>
      </header>
      <main id="main" className="mx-auto w-full max-w-md px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">{title}</h1>
        {children}
        {footer ? <div className="mt-6 space-y-2 text-sm">{footer}</div> : null}
      </main>
    </>
  );
}
