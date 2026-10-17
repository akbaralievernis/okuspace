import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Card, EmptyState } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { courseProgress, myLearningCourses } from '@/server/lms/queries';

export default async function LearnPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn`);
  const t = getDictionary(locale);
  const l = t.lms.learn;
  const courses = await myLearningCourses();
  const withProgress = await Promise.all(
    (courses ?? []).map(async (c) => ({ ...c, progress: await courseProgress(c.id, c.studentId === ctx.user.id ? undefined : c.studentId) })),
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={l.title} unavailable={courses === null}>
      <p>
        <Link className="link" href={`/${locale}/app/learn/reports`}>
          {t.grades.myLink}
        </Link>
      </p>
      {withProgress.length === 0 ? (
        <EmptyState title={l.empty} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {withProgress.map((c) => {
            const own = c.studentId === ctx.user.id;
            const query = own ? '' : `?student=${c.studentId}`;
            const target = c.progress?.nextLessonId ?? c.progress?.lastLessonId;
            const pct = c.progress && c.progress.lessonsTotal ? Math.round((100 * c.progress.lessonsCompleted) / c.progress.lessonsTotal) : 0;
            return (
              <li key={`${c.id}-${c.studentId}`}>
                <Card className="space-y-3">
                  <h2 className="text-lg font-semibold">
                    <Link href={`/${locale}/app/learn/${c.id}${query}`} className="text-ink no-underline hover:underline">
                      {c.title}
                    </Link>
                  </h2>
                  {c.progress ? (
                    <>
                      <p className="text-sm text-muted">{fmt(l.progress, { done: c.progress.lessonsCompleted, total: c.progress.lessonsTotal })}</p>
                      <progress className="h-2 w-full accent-brand-700" max={100} value={pct} aria-label={fmt(l.progress, { done: c.progress.lessonsCompleted, total: c.progress.lessonsTotal })} />
                    </>
                  ) : null}
                  {own && target ? (
                    <ButtonLink href={`/${locale}/app/learn/lessons/${target}`}>{c.progress?.lessonsCompleted ? l.continue : l.start}</ButtonLink>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePage>
  );
}
