import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Badge, EmptyState } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { attemptReview, courseProgress, describeAnswer, myLearningCourses } from '@/server/lms/queries';
import { createUserClient } from '@/server/supabase/server';

type Props = { params: Promise<{ locale: string; courseId: string }>; searchParams: Promise<{ student?: string }> };

export default async function LearnCoursePage({ params, searchParams }: Props) {
  const { locale, courseId } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(courseId)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn/${courseId}`);
  const t = getDictionary(locale);
  const l = t.lms.learn;
  const requested = (await searchParams).student;

  const mine = (await myLearningCourses()) ?? [];
  const entry = mine.find((c) => c.id === courseId && (requested ? c.studentId === requested : c.studentId === ctx.user.id)) ?? mine.find((c) => c.id === courseId);
  if (!entry) notFound();
  const own = entry.studentId === ctx.user.id;
  const studentId = entry.studentId;

  const db = await createUserClient();
  const [progress, modules, lessons, groups] = await Promise.all([
    courseProgress(courseId, own ? undefined : studentId),
    db.from('course_modules').select('id, title, position').eq('course_id', courseId).order('position'),
    db.from('lessons').select('id, module_id, title, position, estimated_minutes').eq('course_id', courseId).order('position'),
    db.from('enrollments').select('group_id, groups!inner(course_id, branch_id)').eq('student_id', studentId).neq('status', 'cancelled'),
  ]);
  const groupIds = ((groups.data ?? []) as { group_id: string; groups: { course_id: string } | { course_id: string }[] }[])
    .filter((g) => (Array.isArray(g.groups) ? g.groups[0]?.course_id : g.groups.course_id) === courseId)
    .map((g) => g.group_id);
  const none = ['00000000-0000-0000-0000-000000000000'];
  const [gas, tests, retakes, homework, branchTz] = await Promise.all([
    db.from('group_assessments').select('assessment_id, opens_at, due_at').in('group_id', groupIds.length ? groupIds : none),
    db.from('assessments').select('id, title, max_attempts, reveal_answers').eq('course_id', courseId),
    db.from('assessment_retakes').select('assessment_id, extra_attempts').eq('student_id', studentId),
    db.from('assignments').select('id, title, due_at, max_score, status').in('group_id', groupIds.length ? groupIds : none).neq('status', 'draft').order('created_at', { ascending: false }),
    db.from('groups').select('branches(timezone)').in('id', groupIds.length ? groupIds : none).limit(1).maybeSingle(),
  ]);
  const tz = ((branchTz.data as { branches?: { timezone?: string } } | null)?.branches?.timezone as string | undefined) ?? DEFAULT_TIMEZONE;
  const { data: submissions } = (homework.data ?? []).length
    ? await db.from('assignment_submissions').select('assignment_id, status, score').eq('student_id', studentId)
    : { data: [] };
  const { data: attempts } = await db.from('assessment_attempts').select('id, assessment_id, attempt_no, score, max_score').eq('student_id', studentId).order('submitted_at', { ascending: false });

  const completed = new Set(progress?.completedLessonIds ?? []);
  const nowIso = new Date().toISOString();
  const openTests = (gas.data ?? []).filter((g) => (g.opens_at as string) <= nowIso);
  const latestAttempt = new Map<string, string>();
  for (const a of attempts ?? []) if (!latestAttempt.has(a.assessment_id as string)) latestAttempt.set(a.assessment_id as string, a.id as string);
  const reviews = (await Promise.all([...latestAttempt.values()].map((id) => attemptReview(id)))).filter((r) => r !== null);
  const mistakes = reviews.flatMap((r) => r.questions.filter((q) => !q.isCorrect).map((q) => ({ review: r, q })));
  const target = progress?.nextLessonId ?? progress?.lastLessonId;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={entry.title} unavailable={!progress}>
      {progress ? (
        <div className="flex flex-wrap items-center gap-4">
          <p>{fmt(l.progress, { done: progress.lessonsCompleted, total: progress.lessonsTotal })}</p>
          {own && target ? <ButtonLink href={`/${locale}/app/learn/lessons/${target}`}>{progress.lessonsCompleted ? l.continue : l.start}</ButtonLink> : null}
        </div>
      ) : null}

      <section aria-labelledby="outline-h" className="space-y-4">
        <h2 id="outline-h" className="text-2xl font-bold">
          {l.outline}
        </h2>
        {(modules.data ?? []).length === 0 ? <EmptyState title={t.lms.courses.empty} /> : null}
        {(modules.data ?? []).map((mod) => (
          <div key={mod.id as string} className="space-y-2">
            <h3 className="text-lg font-semibold">{mod.title as string}</h3>
            <ol className="space-y-1">
              {(lessons.data ?? []).filter((x) => x.module_id === mod.id).map((lesson) => (
                <li key={lesson.id as string} className="flex flex-wrap items-center gap-2">
                  {own ? (
                    <Link className="link" href={`/${locale}/app/learn/lessons/${lesson.id as string}`}>
                      {lesson.title as string}
                    </Link>
                  ) : (
                    <span>{lesson.title as string}</span>
                  )}
                  {completed.has(lesson.id as string) ? <Badge tone="success">{l.completed}</Badge> : null}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      <section aria-labelledby="tests-h" className="space-y-3">
        <h2 id="tests-h" className="text-2xl font-bold">
          {l.testsTitle}
        </h2>
        {openTests.length === 0 ? <p className="text-muted">—</p> : null}
        <ul className="space-y-2">
          {openTests.map((g) => {
            const test = (tests.data ?? []).find((x) => x.id === g.assessment_id);
            if (!test) return null;
            const used = (attempts ?? []).filter((a) => a.assessment_id === test.id).length;
            const allowed = (test.max_attempts as number) + (retakes.data ?? []).filter((r) => r.assessment_id === test.id).reduce((s, r) => s + (r.extra_attempts as number), 0);
            const best = progress?.assessments.find((a) => a.assessmentId === test.id);
            const last = latestAttempt.get(test.id as string);
            return (
              <li key={test.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
                <span>
                  {test.title as string} · {g.due_at ? fmt(l.due, { date: formatDateTime(locale, g.due_at as string, tz) }) : l.noDue}
                  {best ? ` · ${fmt(l.bestScore, { score: best.bestScore, max: best.maxScore })}` : ''}
                </span>
                <span className="flex flex-wrap gap-3">
                  {last ? (
                    <Link className="link" href={`/${locale}/app/learn/attempts/${last}`}>
                      {l.reviewAttempt}
                    </Link>
                  ) : null}
                  {own ? (
                    allowed - used > 0 ? (
                      <Link className="link" href={`/${locale}/app/learn/tests/${test.id as string}`}>
                        {l.take} ({fmt(l.attemptsLeft, { count: allowed - used })})
                      </Link>
                    ) : (
                      <span className="text-muted">{l.noAttemptsLeft}</span>
                    )
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="hw-h" className="space-y-3">
        <h2 id="hw-h" className="text-2xl font-bold">
          {l.homeworkTitle}
        </h2>
        {(homework.data ?? []).length === 0 ? <p className="text-muted">—</p> : null}
        <ul className="space-y-2">
          {(homework.data ?? []).map((hw) => {
            const sub = (submissions ?? []).find((s) => s.assignment_id === hw.id);
            return (
              <li key={hw.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
                <span>
                  {hw.title as string}
                  {hw.due_at ? ` · ${fmt(l.due, { date: formatDateTime(locale, hw.due_at as string, tz) })}` : ''}
                  {sub ? (
                    <>
                      {' '}
                      <Badge tone={sub.status === 'graded' ? 'success' : sub.status === 'returned' ? 'warning' : 'neutral'}>{l.homeworkStatuses[sub.status as 'submitted']}</Badge>
                    </>
                  ) : null}
                  {sub?.status === 'graded' ? ` · ${fmt(l.homeworkScore, { score: String(sub.score), max: String(hw.max_score) })}` : ''}
                </span>
                <Link className="link" href={`/${locale}/app/learn/homework/${hw.id as string}${own ? '' : `?student=${studentId}`}`}>
                  {own && sub?.status !== 'graded' ? l.submitHomework : t.lms.common.open}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="mistakes-h" className="space-y-3">
        <h2 id="mistakes-h" className="text-2xl font-bold">
          {l.mistakesTitle}
        </h2>
        {mistakes.length === 0 ? (
          <p className="text-muted">{l.noMistakes}</p>
        ) : (
          <ul className="space-y-3">
            {mistakes.map(({ review, q }) => (
              <li key={`${review.attemptId}-${q.id}`} className="space-y-1 rounded-[var(--radius-control)] border border-border p-3">
                <p className="whitespace-pre-wrap">{q.prompt}</p>
                <p className="text-sm">
                  {l.yourAnswer}: {describeAnswer(q.type, q.answer, q.options) || l.noAnswer}
                </p>
                {q.key ? (
                  <p className="text-sm text-success-800">
                    {l.correctAnswer}: {describeAnswer(q.type, q.key, q.options)}
                  </p>
                ) : null}
                {q.explanation ? <p className="text-sm text-muted">{q.explanation}</p> : null}
                <Link className="link text-sm" href={`/${locale}/app/learn/attempts/${review.attemptId}`}>
                  {l.reviewAttempt}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </WorkspacePage>
  );
}
