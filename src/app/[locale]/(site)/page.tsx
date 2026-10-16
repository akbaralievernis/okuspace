import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { EmptyState, Notice } from '@/components/ui/notice';
import { CourseCard } from '@/features/site/course-card';
import { formatDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { getCatalog, getSite, getTrialSlots } from '@/server/public/site';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const h = t.site.home;
  const [site, catalog, slots] = await Promise.all([getSite(), getCatalog(), getTrialSlots()]);
  const name = site.ok && site.data ? site.data.name : h.fallbackTitle;
  const languages = catalog.ok ? [...new Map(catalog.data.map((c) => [c.language.code, c.language.name])).values()] : [];
  const cities = site.ok && site.data ? [...new Set(site.data.branches.map((b) => b.city))] : [];

  return (
    <div className="space-y-16">
      <section aria-labelledby="hero-h" className="rounded-[var(--radius-card)] bg-brand-50 px-6 py-12 sm:px-10">
        <p className="text-sm font-medium uppercase tracking-wide text-brand-800">{t.home.status}</p>
        <h1 id="hero-h" className="mt-3 text-4xl font-bold sm:text-5xl">
          {name}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">{h.lead}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href={`/${locale}/courses`} size="lg">
            {h.ctaCourses}
          </ButtonLink>
          <ButtonLink href={`/${locale}/trial`} size="lg" variant="secondary">
            {h.ctaTrial}
          </ButtonLink>
        </div>
      </section>

      {!site.ok ? <Notice tone="warning">{t.site.unavailable}</Notice> : site.data === null ? <Notice tone="info">{t.site.notConfigured}</Notice> : null}

      {languages.length > 0 || cities.length > 0 ? (
        <section aria-labelledby="facts-h" className="grid gap-6 sm:grid-cols-2">
          <h2 id="facts-h" className="sr-only">
            {h.languagesTitle}
          </h2>
          {languages.length > 0 ? (
            <div>
              <h3 className="text-lg font-semibold">{h.languagesTitle}</h3>
              <p className="mt-1 text-muted">{languages.join(' · ')}</p>
            </div>
          ) : null}
          {cities.length > 0 ? (
            <div>
              <h3 className="text-lg font-semibold">{h.branchesTitle}</h3>
              <p className="mt-1 text-muted">
                <Link className="link" href={`/${locale}/branches`}>
                  {cities.join(' · ')}
                </Link>
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="courses-h" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="courses-h" className="text-2xl font-bold">
            {h.coursesTitle}
          </h2>
          <Link className="link" href={`/${locale}/courses`}>
            {h.allCourses}
          </Link>
        </div>
        {!catalog.ok ? (
          <Notice tone="warning">{t.site.unavailable}</Notice>
        ) : catalog.data.length === 0 ? (
          <EmptyState title={h.noCourses} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.data.slice(0, 3).map((c) => (
              <li key={c.id} className="relative">
                <CourseCard course={c} locale={locale} t={t} headingLevel="h3" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {slots.ok && slots.data.length > 0 ? (
        <section aria-labelledby="trial-h" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="trial-h" className="text-2xl font-bold">
              {h.trialTitle}
            </h2>
            <Link className="link" href={`/${locale}/trial`}>
              {h.allSlots}
            </Link>
          </div>
          <ul className="space-y-2">
            {slots.data.slice(0, 3).map((s) => (
              <li key={s.id} className="rounded-[var(--radius-control)] border border-border px-4 py-3">
                {formatDateTime(locale, s.startsAt, s.timezone)} · {s.branch} · {t.site.formats[s.format]}
                {s.course ? ` · ${s.course}` : ''} · {fmt(t.site.trial.spots, { count: s.freeSpots })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
