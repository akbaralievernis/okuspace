import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Field } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { Disputes, type Dispute } from '@/features/ai/disputes';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { submitPracticeAction } from '@/server/ai/actions';
import { ExercisesOutput } from '@/server/ai/outputs';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

export default async function PracticePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/ai/practice/${id}`);
  const t = getDictionary(locale);
  const a = t.ai;
  const db = await createUserClient();
  const { data: fb } = await db.from('ai_feedback').select('id, profile_id, kind, result').eq('id', id).maybeSingle();
  if (!fb) notFound();
  if (fb.kind !== 'exercises') redirect(`/${locale}/app/ai/feedback/${id}`);
  const parsed = ExercisesOutput.safeParse(fb.result);
  const own = fb.profile_id === ctx.user.id;

  const [{ data: results }, { data: disputes }, { data: canResolve }] = await Promise.all([
    db.from('ai_practice_results').select('answers, correct_count, item_count, created_at').eq('feedback_id', id).order('created_at', { ascending: false }).limit(1),
    db.from('ai_feedback_disputes').select('id, opened_by, comment, status, resolution').eq('feedback_id', id).order('created_at'),
    db.rpc('ai_can_resolve', { p_feedback: id }),
  ]);
  const last = results?.[0];
  const answers = (last?.answers ?? {}) as Record<string, string>;
  const { data: names } = await db.from('profiles').select('id, full_name').in('id', [...new Set((disputes ?? []).map((d) => d.opened_by as string))]);
  const list: Dispute[] = (disputes ?? []).map((d) => ({
    id: d.id as string,
    openedBy: d.opened_by as string,
    openedByName: ((names ?? []).find((p) => p.id === d.opened_by)?.full_name as string) || '—',
    comment: d.comment as string,
    status: d.status as Dispute['status'],
    resolution: (d.resolution as string | null) ?? null,
  }));
  const canOpen = (own || canResolve === true) && !list.some((d) => d.openedBy === ctx.user.id);

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={a.practiceTitle} unavailable={!parsed.success}>
      <p>
        <Link className="link" href={`/${locale}/app/ai`}>
          {a.back}
        </Link>
      </p>
      {parsed.success ? (
        <>
          <Notice tone="info">{a.limits}</Notice>
          {own ? (
            <ActionForm action={submitPracticeAction} submitLabel={a.checkAnswers} pendingLabel={t.common.pending} messages={authMessages(t)}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="feedbackId" value={id} />
              <ol className="space-y-4">
                {parsed.data.exercises.map((e, i) => (
                  <li key={e.id} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
                    <p className="font-semibold">
                      {i + 1}. {e.prompt}
                    </p>
                    {e.hint ? (
                      <p className="text-sm text-muted">
                        {a.hint}: {e.hint}
                      </p>
                    ) : null}
                    <Field name={e.id} label={a.answer} autoComplete="off" maxLength={200} idPrefix="px" />
                  </li>
                ))}
              </ol>
            </ActionForm>
          ) : null}
          {last ? (
            <section aria-labelledby="ans-h" className="space-y-3">
              <h2 id="ans-h" className="text-xl font-bold">
                {a.answersTitle}
              </h2>
              <p>{fmt(t.auth.success.practice_checked, { correct: last.correct_count as number, total: last.item_count as number })}</p>
              <ol className="space-y-3">
                {parsed.data.exercises.map((e, i) => (
                  <li key={e.id} className="space-y-1 rounded-[var(--radius-control)] border border-border p-3">
                    <p>
                      {i + 1}. {e.prompt} <Badge>{a.categories[e.category]}</Badge>
                    </p>
                    <p className="text-sm">
                      {a.answer}: {answers[e.id] || '—'} · {a.accepted}: <strong>{e.accepted.join(' / ')}</strong>
                    </p>
                    <p className="text-sm text-muted">{e.explanation}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          <Disputes feedbackId={id} disputes={list} canOpen={canOpen} canResolve={canResolve === true} locale={locale} t={t} />
        </>
      ) : null}
    </WorkspacePage>
  );
}
