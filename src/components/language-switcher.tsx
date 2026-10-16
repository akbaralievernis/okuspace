'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { locales, switchLocaleInPath, type Locale } from '@/i18n/config';
import { localeNames } from '@/i18n/get-dictionary';

/** Переключает язык, сохраняя текущий путь и параметры запроса. */
export function LanguageSwitcher({ current, label }: { current: Locale; label: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  return (
    <nav aria-label={label}>
      <ul className="flex gap-1">
        {locales.map((locale) => {
          const href = `${switchLocaleInPath(pathname, locale)}${search ? `?${search}` : ''}`;
          const active = locale === current;
          return (
            <li key={locale}>
              <Link
                href={href}
                hrefLang={locale}
                lang={locale}
                aria-current={active ? 'true' : undefined}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm ${
                  active ? 'bg-brand-700 text-white' : 'text-ink hover:bg-surface-muted'
                }`}
              >
                {localeNames[locale]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
