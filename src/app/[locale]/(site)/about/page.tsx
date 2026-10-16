import { notFound } from 'next/navigation';
import { ContentPage } from '@/features/site/content-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getPage } from '@/server/public/site';

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  return <ContentPage page={await getPage('about', locale)} fallbackTitle={t.site.nav.about} emptyText={t.site.pages.aboutEmpty} locale={locale} t={t} />;
}
