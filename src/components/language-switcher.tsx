'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { locales, switchLocaleInPath, type Locale } from '@/i18n/config';
import { localeNames } from '@/i18n/get-dictionary';

const CODES: Record<Locale, string> = { ky: 'KG', ru: 'RU', en: 'EN' };

/**
 * Переключает язык, сохраняя текущий путь и параметры запроса.
 * compact — короткие коды RU / KG / EN (шапка сайта); доступное имя содержит и название языка, и код.
 */
export function LanguageSwitcher({ current, label, compact = false }: { current: Locale; label: string; compact?: boolean }) {
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
                aria-label={compact ? `${localeNames[locale]} (${CODES[locale]})` : undefined}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-sm ${compact ? 'px-2 font-bold' : 'px-3'} ${
                  active ? 'bg-brand-700 text-white' : 'text-ink hover:bg-surface-muted'
                }`}
              >
                {compact ? CODES[locale] : localeNames[locale]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
