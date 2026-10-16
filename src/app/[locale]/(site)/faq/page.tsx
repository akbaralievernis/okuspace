import { notFound } from 'next/navigation';
import { ContentPage } from '@/features/site/content-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getPage } from '@/server/public/site';

export default async function FaqPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  return <ContentPage page={await getPage('faq', locale)} fallbackTitle={t.site.nav.faq} emptyText={t.site.pages.faqEmpty} locale={locale} t={t} />;
}
