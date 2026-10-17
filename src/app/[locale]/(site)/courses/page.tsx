import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClasses } from '@/components/ui/button';
import { SelectField } from '@/components/ui/controls';
import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { CourseCard } from '@/features/site/course-card';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { filterCatalog, type CatalogFilters } from '@/server/public/schemas';
import { getCatalog, getSite } from '@/server/public/site';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.length <= 64 ? v : undefined);

export default async function CoursesPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const c = t.site.courses;
  const q = await searchParams;
  const filters: CatalogFilters = { language: one(q.language), level: one(q.level), format: one(q.format), branch: one(q.branch) };
  const [catalog, site] = await Promise.all([getCatalog(), getSite()]);

  if (!catalog.ok) {
    return (
      <>
        <PageHeader title={c.title} lead={c.lead} />
        <Notice tone="warning">{t.site.unavailable}</Notice>
      </>
    );
  }

  const all = catalog.data;
  const shown = filterCatalog(all, filters);
  const languages = [...new Map(all.flatMap((x) => (x.language ? [[x.language.code, x.language.name] as const] : []))).entries()];
  const levels = [...new Map(all.flatMap((x) => (x.level ? [[x.level.code, x.level.order] as const] : []))).entries()].sort((a, b) => a[1] - b[1]).map(([code]) => code);
  const branches = site.ok && site.data ? site.data.branches : [];
  const active = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader title={c.title} lead={c.lead} />
      {all.length > 0 ? (
        <form method="get" className="mb-8 grid gap-4 rounded-[var(--radius-card)] border border-border bg-surface-muted p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <SelectField name="language" label={c.language} defaultValue={filters.language ?? ''}>
            <option value="">{c.any}</option>
            {languages.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </SelectField>
          <SelectField name="level" label={c.level} defaultValue={filters.level ?? ''}>
            <option value="">{c.any}</option>
            {levels.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </SelectField>
          <SelectField name="format" label={c.format} defaultValue={filters.format ?? ''}>
            <option value="">{c.any}</option>
            {(['offline', 'online', 'hybrid'] as const).map((f) => (
              <option key={f} value={f}>
                {t.site.formats[f]}
              </option>
            ))}
          </SelectField>
          <SelectField name="branch" label={c.branch} defaultValue={filters.branch ?? ''}>
            <option value="">{c.any}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.city} — {b.name}
              </option>
            ))}
          </SelectField>
          <div className="flex gap-2">
            <button type="submit" className={buttonClasses('primary')}>
              {c.apply}
            </button>
            {active ? (
              <Link href={`/${locale}/courses`} className={buttonClasses('ghost')}>
                {c.reset}
              </Link>
            ) : null}
          </div>
        </form>
      ) : null}

      {all.length === 0 ? (
        <EmptyState title={c.empty} />
      ) : shown.length === 0 ? (
        <EmptyState title={c.emptyFiltered} />
      ) : (
        <>
          <p role="status" className="mb-4 text-muted">
            {fmt(c.found, { count: shown.length })}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((course) => (
              <li key={course.id} className="relative">
                <CourseCard course={course} locale={locale} t={t} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
