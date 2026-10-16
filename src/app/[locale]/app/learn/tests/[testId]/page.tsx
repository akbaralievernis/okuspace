import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Notice } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { submitAttemptAction } from '@/server/lms/actions';
import { gapCount } from '@/server/lms/schemas';
import { createUserClient } from '@/server/supabase/server';

type Question = { id: string; type: 'single_choice' | 'multiple_choice' | 'short_text' | 'gap_fill'; prompt: string; options: { id: string; text: string }[]; points: string };

const input = 'w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2';

export default async function TakeTestPage({ params }: { params: Promise<{ locale: string; testId: string }> }) {
  const { locale, testId } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(testId)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn/tests/${testId}`);
  const t = getDictionary(locale);
  const l = t.lms.learn;

  const db = await createUserClient();
  const { data: test } = await db.from('assessments').select('id, course_id, title, instructions, max_attempts, status').eq('id', testId).maybeSingle();
  if (!test || test.status !== 'published') notFound();
  const [{ data: questions }, { data: windows }, { data: attempts }, { data: retakes }] = await Promise.all([
    // Варианты ответов без признака правильности: ключи лежат в отдельной таблице, недоступной ученику.
    db.from('assessment_questions').select('id, type, prompt, options, points').eq('assessment_id', testId).order('position'),
    db.from('group_assessments').select('opens_at, due_at').eq('assessment_id', testId),
    db.from('assessment_attempts').select('id').eq('assessment_id', testId).eq('student_id', ctx.user.id),
    db.from('assessment_retakes').select('extra_attempts').eq('assessment_id', testId).eq('student_id', ctx.user.id),
  ]);
  const now = new Date().toISOString();
  const open = (windows ?? []).some((w) => (w.opens_at as string) <= now);
  const left = (test.max_attempts as number) + (retakes ?? []).reduce((s, r) => s + (r.extra_attempts as number), 0) - (attempts ?? []).length;
  const qs = (questions ?? []) as Question[];
  // Ключ идемпотентности создаётся при показе формы: двойная отправка той же формы даёт одну попытку.
  const idempotencyKey = randomUUID();

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={test.title as string}>
      <p>
        <Link className="link" href={`/${locale}/app/learn/${test.course_id as string}`}>
          {l.outline}
        </Link>
      </p>
      {test.instructions ? <RichText text={test.instructions as string} /> : null}
      {!open || qs.length === 0 ? (
        <Notice tone="warning">{t.auth.errors.forbidden}</Notice>
      ) : left <= 0 ? (
        <Notice tone="warning">{l.noAttemptsLeft}</Notice>
      ) : (
        <>
          <Notice tone="info">
            {l.testIntro} {fmt(l.attemptsLeft, { count: left })}
          </Notice>
          <ActionForm action={submitAttemptAction} submitLabel={l.submitTest} pendingLabel={t.common.pending} messages={authMessages(t)} className="space-y-6">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="assessmentId" value={testId} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <ol className="space-y-6">
              {qs.map((q, n) => (
                <li key={q.id}>
                  <QuestionField q={q} n={n + 1} labels={l} />
                </li>
              ))}
            </ol>
          </ActionForm>
        </>
      )}
    </WorkspacePage>
  );
}

function QuestionField({ q, n, labels }: { q: Question; n: number; labels: ReturnType<typeof getDictionary>['lms']['learn'] }) {
  const name = `q_${q.id}`;
  const legend = (
    <legend className="mb-3 font-semibold">
      <span className="mr-2">{n}.</span>
      <span className="whitespace-pre-wrap">{q.prompt}</span>
      <span className="ml-2 text-sm font-normal text-muted">({fmt(labels.maxPoints, { max: q.points })})</span>
    </legend>
  );
  if (q.type === 'single_choice' || q.type === 'multiple_choice') {
    const kind = q.type === 'single_choice' ? 'radio' : 'checkbox';
    return (
      <fieldset className="rounded-[var(--radius-card)] border border-border p-4">
        {legend}
        <div className="space-y-2">
          {q.options.map((o) => (
            <label key={o.id} className="flex items-center gap-3">
              <input type={kind} name={name} value={o.id} className="size-5 accent-brand-700" />
              <span>{o.text}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (q.type === 'short_text') {
    return (
      <fieldset className="rounded-[var(--radius-card)] border border-border p-4">
        {legend}
        <label className="sr-only" htmlFor={`${name}-input`}>
          {labels.yourAnswer}
        </label>
        <input id={`${name}-input`} name={name} type="text" autoComplete="off" maxLength={500} className={input} />
      </fieldset>
    );
  }
  const gaps = gapCount(q.prompt);
  return (
    <fieldset className="rounded-[var(--radius-card)] border border-border p-4">
      {legend}
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: gaps }, (_, i) => (
          <div key={i} className="space-y-1">
            <label className="block text-sm font-medium" htmlFor={`${name}-${i}`}>
              {fmt(labels.gap, { n: i + 1 })}
            </label>
            <input id={`${name}-${i}`} name={`${name}_${i}`} type="text" autoComplete="off" maxLength={200} className={input} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}
