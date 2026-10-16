import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Notice } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { attemptReview, describeAnswer } from '@/server/lms/queries';
import { createUserClient } from '@/server/supabase/server';

export default async function AttemptPage({ params }: { params: Promise<{ locale: string; attemptId: string }> }) {
  const { locale, attemptId } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(attemptId)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn/attempts/${attemptId}`);
  const t = getDictionary(locale);
  const l = t.lms.learn;

  // Права и правила показа ответов проверяет attempt_review: чужая попытка → ошибка → 404.
  const review = await attemptReview(attemptId);
  if (!review) notFound();
  const db = await createUserClient();
  const { data: test } = await db.from('assessments').select('title, course_id, reveal_answers').eq('id', review.assessmentId).maybeSingle();
  const reveal = (test?.reveal_answers as 'never' | 'after_submit' | 'after_due' | undefined) ?? 'never';

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${l.resultTitle}: ${(test?.title as string | undefined) ?? ''}`}>
      {test ? (
        <p>
          <Link className="link" href={`/${locale}/app/learn/${test.course_id as string}`}>
            {l.outline}
          </Link>
        </p>
      ) : null}
      <div className="space-y-1">
        <p className="text-2xl font-bold">{fmt(l.score, { score: review.score, max: review.maxScore })}</p>
        <p className="text-sm text-muted">
          #{review.attemptNo} · {formatDateTime(locale, review.submittedAt, DEFAULT_TIMEZONE)}
        </p>
      </div>
      {!review.answersRevealed && reveal !== 'after_submit' ? <Notice tone="info">{l.answersHidden[reveal]}</Notice> : null}

      <ol className="space-y-4">
        {review.questions.map((q, n) => (
          <li key={q.id} className="space-y-2 rounded-[var(--radius-card)] border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-semibold whitespace-pre-wrap">
                {n + 1}. {q.prompt}
              </p>
              <Badge tone={q.isCorrect ? 'success' : 'warning'}>{q.isCorrect ? l.correct : l.incorrect}</Badge>
            </div>
            <p className="text-sm">
              {l.yourAnswer}: {describeAnswer(q.type, q.answer, q.options) || l.noAnswer}
            </p>
            <p className="text-sm text-muted">{fmt(l.points, { got: q.pointsAwarded, max: q.points })}</p>
            {q.key ? (
              <p className="text-sm text-success-800">
                {l.correctAnswer}: {describeAnswer(q.type, q.key, q.options)}
              </p>
            ) : null}
            {q.explanation ? <p className="text-sm">{q.explanation}</p> : null}
          </li>
        ))}
      </ol>
    </WorkspacePage>
  );
}
