import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { legalKinds, legalSlug } from '@/server/public/schemas';
import { getLegal } from '@/server/public/site';

export default async function LegalPage({ params }: { params: Promise<{ locale: string; doc: string }> }) {
  const { locale, doc } = await params;
  const kind = legalKinds.find((k) => legalSlug[k] === doc);
  if (!isLocale(locale) || !kind) notFound();
  const t = getDictionary(locale);
  const title = t.site.legal[kind];
  const legal = await getLegal(kind, locale);

  if (!legal.ok) {
    return (
      <>
        <PageHeader title={title} />
        <Notice tone="warning">{t.site.unavailable}</Notice>
      </>
    );
  }
  if (!legal.data) {
    return (
      <>
        <PageHeader title={title} />
        <EmptyState title={t.site.legal.notPublished} />
      </>
    );
  }
  return (
    <article>
      <PageHeader title={legal.data.title} lead={fmt(t.site.legal.version, { date: formatDate(locale, legal.data.version) })} />
      <RichText text={legal.data.body} />
    </article>
  );
}
