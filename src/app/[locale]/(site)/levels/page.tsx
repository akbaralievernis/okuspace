import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getLevels } from '@/server/public/site';

export default async function LevelsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const l = t.site.levels;
  const levels = await getLevels();
  const cefr = l.cefr as Record<string, string>;

  return (
    <>
      <PageHeader title={l.title} lead={l.lead} />
      {!levels.ok ? (
        <Notice tone="warning">{t.site.unavailable}</Notice>
      ) : levels.data.length === 0 ? (
        <EmptyState title={l.empty} />
      ) : (
        <div className="space-y-10">
          {levels.data.map((lang) => (
            <section key={lang.code} aria-labelledby={`lang-${lang.code}`}>
              <h2 id={`lang-${lang.code}`} className="mb-3 text-2xl font-bold">
                {lang.name}
              </h2>
              <dl className="grid gap-3 sm:grid-cols-2">
                {lang.levels.map((lv) => (
                  <div key={lv.code} className="rounded-[var(--radius-control)] border border-border p-4">
                    <dt className="font-semibold">
                      {lv.code} · {lv.title}
                    </dt>
                    {lv.framework === 'cefr' && cefr[lv.code] ? <dd className="mt-1 text-muted">{cefr[lv.code]}</dd> : null}
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
