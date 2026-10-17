import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { WhatsAppFab } from '@/features/site/whatsapp-fab';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getCurrentUser } from '@/server/auth/session';
import { nowMs } from '@/server/management/period';
import { parseSiteContent } from '@/server/public/content';
import { getSite } from '@/server/public/site';

/** Каркас публичных страниц: шапка, основное содержимое, подвал, кнопка WhatsApp. */
export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const [site, user] = await Promise.all([getSite(), getCurrentUser()]);
  const data = site.ok ? site.data : null;
  const siteName = data ? data.name : t.site.home.fallbackTitle;
  const content = parseSiteContent(data?.settings);
  const chrome = { locale, t, siteName, site: data, content };
  const wa = (data?.branches ?? []).filter((b) => b.whatsapp).map((b) => ({ id: b.id, name: b.name, phone: b.whatsapp! }));

  return (
    <>
      <SiteHeader {...chrome} signedIn={!!user} />
      <main id="main" className="container-page py-10">
        {children}
      </main>
      <SiteFooter {...chrome} year={new Date(nowMs()).getFullYear()} />
      {wa.length ? <WhatsAppFab branches={wa} label={t.site.home2.whatsapp} chooseLabel={t.site.home2.waChoose} closeLabel={t.site.home2.waClose} /> : null}
    </>
  );
}
