import Link from 'next/link';
import { Badge, Card } from '@/components/ui/notice';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { fmt } from '@/lib/format';
import type { Course } from '@/server/public/schemas';
import { formatPrice } from './format';

export function PriceLabel({ course, locale, t }: { course: Course; locale: Locale; t: Dictionary }) {
  if (!course.price) return <span className="text-muted">{t.site.courses.priceOnRequest}</span>;
  return (
    <span className="font-semibold">
      {formatPrice(locale, course.price.amount, course.price.currency)} {t.site.priceUnits[course.price.unit]}
    </span>
  );
}

/** Карточка курса: язык, уровень, формат, длительность, цена, наличие мест. Заголовок — ссылка на курс. */
export function CourseCard({ course, locale, t, headingLevel = 'h2' }: { course: Course; locale: Locale; t: Dictionary; headingLevel?: 'h2' | 'h3' }) {
  const Heading = headingLevel;
  const openSeats = course.groups.reduce((sum, g) => sum + g.freeSeats, 0);
  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Badge tone="brand">{course.language.name}</Badge>
        <Badge>{course.level.code}</Badge>
        <Badge>{t.site.formats[course.format]}</Badge>
      </div>
      <Heading className="text-lg font-semibold">
        <Link href={`/${locale}/courses/${course.id}`} className="text-ink no-underline after:absolute after:inset-0 hover:underline">
          {course.title}
        </Link>
      </Heading>
      <p className="text-sm text-muted">{fmt(t.site.courses.duration, { weeks: course.durationWeeks, lessons: course.lessonsPerWeek })}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
        <PriceLabel course={course} locale={locale} t={t} />
        {openSeats > 0 ? <Badge tone="success">{fmt(t.site.courses.seats, { count: openSeats })}</Badge> : null}
      </div>
    </Card>
  );
}
