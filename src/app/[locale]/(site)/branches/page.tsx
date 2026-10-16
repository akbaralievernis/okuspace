import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { BranchList } from '@/features/site/branch-list';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getSite } from '@/server/public/site';

export default async function BranchesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const b = t.site.branches;
  const site = await getSite();

  return (
    <>
      <PageHeader title={b.title} />
      {!site.ok ? (
        <Notice tone="warning">{t.site.unavailable}</Notice>
      ) : !site.data || site.data.branches.length === 0 ? (
        <EmptyState title={b.empty} />
      ) : (
        <BranchList branches={site.data.branches} labels={b} />
      )}
    </>
  );
}
