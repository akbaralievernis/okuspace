import Link from 'next/link';
import { Suspense } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { MobileMenu, type NavItem } from '@/components/mobile-menu';
import { buttonClasses } from '@/components/ui/button';
import { Icon, SiteLogo } from '@/features/site/brand';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { pick, waLink, type SiteContent } from '@/server/public/content';
import { legalKinds, legalSlug, type Site } from '@/server/public/schemas';

/** Разделы главной (якоря) и отдельные страницы сайта. */
export function siteNav(locale: Locale, t: Dictionary): { primary: NavItem[]; secondary: NavItem[] } {
  const n = t.site.nav;
  const a = t.site.home2.nav;
  const href = (path: string) => `/${locale}${path}`;
  return {
    primary: [
      { href: href('#courses'), label: a.courses },
      { href: href('#branches'), label: a.branches },
      { href: href('#teachers'), label: a.teachers },
      { href: href('#results'), label: a.results },
      { href: href('/contacts'), label: a.contacts },
    ],
    secondary: [
      { href: href('/courses'), label: t.site.home.allCourses },
      { href: href('/prices'), label: n.prices },
      { href: href('/trial'), label: n.trial },
      { href: href('/about'), label: n.about },
      { href: href('/faq'), label: n.faq },
    ],
  };
}

interface ChromeProps {
  locale: Locale;
  t: Dictionary;
  siteName: string;
  site: Site | null;
  content: SiteContent;
}

export function SiteHeader({ locale, t, siteName, signedIn, content }: ChromeProps & { signedIn: boolean }) {
  const { primary, secondary } = siteNav(locale, t);
  const account = signedIn ? { href: `/${locale}/app`, label: t.site.nav.account } : { href: `/${locale}/login`, label: t.site.home2.signIn };
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
      <div className="container-page flex min-h-16 items-center justify-between gap-3 py-2">
        <Link href={`/${locale}`} className="shrink-0 no-underline" aria-label={siteName}>
          <SiteLogo src={content.logo} name={siteName} className="h-10 sm:h-12" />
        </Link>
        <nav aria-label={t.nav.main} className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {primary.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-2.5 font-semibold text-ink no-underline hover:text-brand-700">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <Suspense>
              <LanguageSwitcher current={locale} label={t.languageSwitcher.label} compact />
            </Suspense>
          </div>
          <Link href={account.href} className="hidden min-h-11 items-center px-2 text-sm font-semibold text-muted no-underline hover:text-brand-700 xl:inline-flex">
            {account.label}
          </Link>
          <Link href={`/${locale}#signup`} className={buttonClasses('cta', 'md', 'max-sm:hidden')}>
            {t.site.home2.signup}
          </Link>
          <MobileMenu
            items={[...primary, { href: `/${locale}#signup`, label: t.site.home2.signup }, ...secondary, account]}
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

/** Подвал — тёмно-зелёный, белый логотип; филиалы с WhatsApp, соцсети, документы. */
export function SiteFooter({ locale, t, siteName, site, content, year }: ChromeProps & { year: number }) {
  const { primary, secondary } = siteNav(locale, t);
  const h = t.site.home2;
  const branches = site?.branches ?? [];
  return (
    <footer className="mt-16 bg-brand-800 text-white">
      <div className="container-page grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-4">
          <SiteLogo src={content.logo} name={siteName} white className="h-12" />
          {content.social?.instagram?.length ? (
            <div>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/80">{h.social}</h2>
              <ul className="space-y-1">
                {content.social.instagram.map((ig) => (
                  <li key={ig.url}>
                    <a className="inline-flex min-h-11 items-center gap-2 text-white underline-offset-4 hover:underline" href={ig.url} rel="noopener noreferrer" target="_blank">
                      <Icon name="instagram" className="size-5" />
                      {ig.handle}
                      {ig.note ? <span className="text-white/80">({pick(ig.note, locale)})</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {branches.length ? (
          <div className="lg:col-span-2">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/80">{h.branchesTitle}</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {branches.map((b) => (
                <li key={b.id} className="text-sm">
                  <p className="font-semibold">{b.name}</p>
                  <p className="text-white/85">{[b.address, b.city].filter(Boolean).join(', ')}</p>
                  {b.whatsapp ? (
                    <a className="inline-flex min-h-11 items-center gap-2 text-white underline-offset-4 hover:underline" href={waLink(b.whatsapp)} rel="noopener noreferrer" target="_blank">
                      <Icon name="whatsapp" className="size-5" />
                      {b.whatsapp}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="grid gap-6">
          <nav aria-label={t.site.nav.sections}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/80">{t.site.nav.sections}</h2>
            <ul className="space-y-1 text-sm">
              {[...primary, ...secondary].map((item) => (
                <li key={item.href}>
                  <Link className="text-white underline-offset-4 hover:underline" href={item.href}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label={t.site.nav.documents}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-white/80">{t.site.nav.documents}</h2>
            <ul className="space-y-1 text-sm">
              {legalKinds.map((kind) => (
                <li key={kind}>
                  <Link className="text-white underline-offset-4 hover:underline" href={`/${locale}/legal/${legalSlug[kind]}`}>
                    {t.site.legal[kind]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
      <p className="container-page border-t border-white/20 py-4 text-sm text-white/85">
        © {year} {siteName}
      </p>
    </footer>
  );
}
