import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getCurrentUser } from '@/server/auth/session';
import { getSite } from '@/server/public/site';

/** Каркас публичных страниц: шапка, основное содержимое, подвал. */
export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const [site, user] = await Promise.all([getSite(), getCurrentUser()]);
  const siteName = site.ok && site.data ? site.data.name : t.site.home.fallbackTitle;

  return (
    <>
      <SiteHeader locale={locale} t={t} siteName={siteName} signedIn={!!user} />
      <main id="main" className="container-page py-10">
        {children}
      </main>
      <SiteFooter locale={locale} t={t} siteName={siteName} />
    </>
  );
}
