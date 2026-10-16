import Link from 'next/link';
import { Suspense } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { MobileMenu, type NavItem } from '@/components/mobile-menu';
import { buttonClasses } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { legalKinds, legalSlug } from '@/server/public/schemas';

export function siteNav(locale: Locale, t: Dictionary): { primary: NavItem[]; secondary: NavItem[] } {
  const n = t.site.nav;
  const href = (path: string) => `/${locale}${path}`;
  return {
    primary: [
      { href: href('/courses'), label: n.courses },
      { href: href('/prices'), label: n.prices },
      { href: href('/trial'), label: n.trial },
      { href: href('/branches'), label: n.branches },
      { href: href('/contacts'), label: n.contacts },
    ],
    secondary: [
      { href: href('/about'), label: n.about },
      { href: href('/levels'), label: n.levels },
      { href: href('/teachers'), label: n.teachers },
      { href: href('/faq'), label: n.faq },
    ],
  };
}

export function SiteHeader({ locale, t, siteName, signedIn }: { locale: Locale; t: Dictionary; siteName: string; signedIn: boolean }) {
  const { primary, secondary } = siteNav(locale, t);
  const account = signedIn ? { href: `/${locale}/app`, label: t.site.nav.account } : { href: `/${locale}/login`, label: t.nav.signIn };
  return (
    <header className="relative border-b border-border bg-surface">
      <div className="container-page flex min-h-16 items-center justify-between gap-3 py-2">
        <Link href={`/${locale}`} className="text-lg font-bold text-ink no-underline">
          {siteName}
        </Link>
        <nav aria-label={t.nav.main} className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {primary.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-ink no-underline hover:bg-surface-muted">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <Suspense>
              <LanguageSwitcher current={locale} label={t.languageSwitcher.label} />
            </Suspense>
          </div>
          <Link href={account.href} className={buttonClasses('secondary', 'md', 'hidden sm:inline-flex')}>
            {account.label}
          </Link>
          <MobileMenu
            items={[...primary, ...secondary, account]}
            label={t.nav.main}
            openLabel={t.site.nav.menu}
            closeLabel={t.site.nav.close}
          />
        </div>
      </div>
      <div className="container-page pb-2 sm:hidden">
        <Suspense>
          <LanguageSwitcher current={locale} label={t.languageSwitcher.label} />
        </Suspense>
      </div>
    </header>
  );
}

export function SiteFooter({ locale, t, siteName }: { locale: Locale; t: Dictionary; siteName: string }) {
  const { primary, secondary } = siteNav(locale, t);
  return (
    <footer className="mt-16 border-t border-border bg-surface-muted">
      <div className="container-page grid gap-8 py-10 sm:grid-cols-3">
        <p className="font-semibold">{siteName}</p>
        <nav aria-label={t.site.nav.sections}>
          <h2 className="mb-2 text-sm font-semibold text-muted">{t.site.nav.sections}</h2>
          <ul className="space-y-1">
            {[...primary, ...secondary].map((item) => (
              <li key={item.href}>
                <Link className="link" href={item.href}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label={t.site.nav.documents}>
          <h2 className="mb-2 text-sm font-semibold text-muted">{t.site.nav.documents}</h2>
          <ul className="space-y-1">
            {legalKinds.map((kind) => (
              <li key={kind}>
                <Link className="link" href={`/${locale}/legal/${legalSlug[kind]}`}>
                  {t.site.legal[kind]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
