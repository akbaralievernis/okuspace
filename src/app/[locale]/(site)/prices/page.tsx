import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { PriceLabel } from '@/features/site/course-card';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getCatalog } from '@/server/public/site';

export default async function PricesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const p = t.site.prices;
  const catalog = await getCatalog();
  const priced = catalog.ok ? catalog.data.filter((c) => c.price) : [];

  return (
    <>
      <PageHeader title={p.title} lead={p.lead} />
      {!catalog.ok ? (
        <Notice tone="warning">{t.site.unavailable}</Notice>
      ) : priced.length === 0 ? (
        <EmptyState title={p.empty} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left">
              <caption className="sr-only">{p.title}</caption>
              <thead>
                <tr className="border-b border-border-strong">
                  <th scope="col" className="py-2 pr-4">
                    {p.course}
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    {t.site.courses.format}
                  </th>
                  <th scope="col" className="py-2">
                    {p.price}
                  </th>
                </tr>
              </thead>
              <tbody>
                {priced.map((c) => (
                  <tr key={c.id} className="border-b border-border">
                    <th scope="row" className="py-3 pr-4 font-normal">
                      <Link className="link" href={`/${locale}/courses/${c.id}`}>
                        {c.title}
                      </Link>{' '}
                      {c.language || c.level ? (
                        <span className="text-sm text-muted">({[c.language?.name, c.level?.code].filter(Boolean).join(', ')})</span>
                      ) : null}
                    </th>
                    <td className="py-3 pr-4">{t.site.formats[c.format]}</td>
                    <td className="py-3">
                      <PriceLabel course={c} locale={locale} t={t} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-muted">{p.note}</p>
        </>
      )}
    </>
  );
}
