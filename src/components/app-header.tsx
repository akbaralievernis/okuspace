import Link from 'next/link';
import { Suspense } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { logoutAction } from '@/server/auth/actions';

/** Шапка кабинета. Пункты меню — только реально существующие разделы. */
export function AppHeader({ locale, t, showMembers }: { locale: Locale; t: Dictionary; showMembers: boolean }) {
  const link = 'inline-flex min-h-11 items-center rounded-md px-3 hover:bg-gray-100';
  return (
    <header className="border-b border-gray-200">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2">
        <nav aria-label={t.nav.main} className="flex flex-wrap items-center gap-1">
          <Link href={`/${locale}/app`} className="mr-2 font-bold">
            Okuspace
          </Link>
          <Link href={`/${locale}/app`} className={link}>
            {t.nav.workspace}
          </Link>
          {showMembers ? (
            <Link href={`/${locale}/app/members`} className={link}>
              {t.nav.members}
            </Link>
          ) : null}
          <Link href={`/${locale}/app/account`} className={link}>
            {t.nav.account}
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <Suspense>
            <LanguageSwitcher current={locale} label={t.languageSwitcher.label} />
          </Suspense>
          <form action={logoutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="inline-flex min-h-11 items-center rounded-md border border-gray-400 px-3 hover:bg-gray-100">
              {t.nav.signOut}
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
