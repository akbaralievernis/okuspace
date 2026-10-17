import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Notice, PageHeader } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { PriceLabel } from '@/features/site/course-card';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { getCatalog } from '@/server/public/site';

export default async function CoursePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = getDictionary(locale);
  const c = t.site.courses;
  const catalog = await getCatalog();

  if (!catalog.ok) {
    return (
      <>
        <PageHeader title={c.title} />
        <Notice tone="warning">{t.site.unavailable}</Notice>
      </>
    );
  }
  const course = catalog.data.find((x) => x.id === id);
  if (!course) notFound();

  const cefr = course.level?.framework === 'cefr' ? t.site.levels.cefr[course.level.code as keyof typeof t.site.levels.cefr] : null;

  return (
    <article className="space-y-10">
      <PageHeader title={course.title}>
        <div className="flex flex-wrap gap-2">
          {course.category ? <Badge tone="brand">{t.site.categories[course.category]}</Badge> : null}
          {course.language ? <Badge tone="brand">{course.language.name}</Badge> : null}
          {course.level ? (
            <Badge>
              {course.level.code} · {course.level.title}
            </Badge>
          ) : null}
          {course.ageNote ? <Badge>{course.ageNote}</Badge> : null}
          <Badge>{t.site.formats[course.format]}</Badge>
          <Badge>{t.site.kinds[course.kind]}</Badge>
        </div>
      </PageHeader>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {course.description ? <RichText text={course.description} /> : null}
          {cefr ? <p className="text-muted">{cefr}</p> : null}
        </div>
        <aside className="space-y-3 rounded-[var(--radius-card)] border border-border p-5">
          <p className="text-xl">
            <PriceLabel course={course} locale={locale} t={t} />
          </p>
          {course.durationWeeks && course.lessonsPerWeek ? <p className="text-muted">{fmt(c.duration, { weeks: course.durationWeeks, lessons: course.lessonsPerWeek })}</p> : null}
          <p className="text-sm text-muted">{t.site.prices.note}</p>
          <div className="flex flex-col gap-2 pt-2">
            <ButtonLink href={`/${locale}/trial`}>{c.trialCta}</ButtonLink>
            <ButtonLink href={`/${locale}/contacts?course=${course.id}`} variant="secondary">
              {c.askCta}
            </ButtonLink>
          </div>
        </aside>
      </div>

      <section aria-labelledby="groups-h" className="space-y-3">
        <h2 id="groups-h" className="text-2xl font-bold">
          {c.groupsTitle}
        </h2>
        {course.groups.length === 0 ? (
          <p className="text-muted">{c.noGroups}</p>
        ) : (
          <ul className="space-y-2">
            {course.groups.map((g, i) => (
              <li key={`${g.branchId}-${g.startsOn}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-4 py-3">
                <span>
                  {g.city}, {g.branch} · {fmt(c.startsOn, { date: formatDate(locale, g.startsOn) })}
                </span>
                {g.freeSeats > 0 && g.enrollment === 'open' ? (
                  <Badge tone="success">{fmt(c.seats, { count: g.freeSeats })}</Badge>
                ) : (
                  <Badge tone="warning">{c.waitlist}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
