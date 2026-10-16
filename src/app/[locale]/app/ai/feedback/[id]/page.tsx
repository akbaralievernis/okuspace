import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Badge, Notice } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { Disputes, type Dispute } from '@/features/ai/disputes';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { GrammarOutput, WritingCheckOutput } from '@/server/ai/outputs';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

export default async function FeedbackPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/ai/feedback/${id}`);
  const t = getDictionary(locale);
  const a = t.ai;
  const db = await createUserClient();
  // RLS: ученик, опекун, преподаватель группы, руководство с learning.read_all.
  const { data: fb } = await db.from('ai_feedback').select('id, organization_id, profile_id, kind, input, result, created_at').eq('id', id).maybeSingle();
  if (!fb) notFound();
  if (fb.kind === 'exercises') redirect(`/${locale}/app/ai/practice/${id}`);
  const own = fb.profile_id === ctx.user.id;

  const [{ data: disputes }, { data: canResolve }] = await Promise.all([
    db.from('ai_feedback_disputes').select('id, opened_by, comment, status, resolution').eq('feedback_id', id).order('created_at'),
    db.rpc('ai_can_resolve', { p_feedback: id }),
  ]);
  const people = [...new Set([fb.profile_id as string, ...(disputes ?? []).map((d) => d.opened_by as string)])];
  const { data: names } = await db.from('profiles').select('id, full_name').in('id', people);
  const nameOf = (pid: string) => ((names ?? []).find((p) => p.id === pid)?.full_name as string) || '—';
  const list: Dispute[] = (disputes ?? []).map((d) => ({
    id: d.id as string,
    openedBy: d.opened_by as string,
    openedByName: nameOf(d.opened_by as string),
    comment: d.comment as string,
    status: d.status as Dispute['status'],
    resolution: (d.resolution as string | null) ?? null,
  }));
  const alreadyOpened = list.some((d) => d.openedBy === ctx.user.id);
  const canOpen = (own || canResolve === true) && !alreadyOpened;

  const writing = fb.kind === 'writing_check' ? WritingCheckOutput.safeParse(fb.result) : null;
  const grammar = fb.kind === 'grammar' ? GrammarOutput.safeParse(fb.result) : null;
  const dropped = Number((fb.result as { dropped?: number }).dropped ?? 0);
  const cat = (c: string) => a.categories[c as 'grammar'] ?? c;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={a.kinds[fb.kind as 'grammar']}>
      <p className="flex flex-wrap gap-3 text-sm text-muted">
        {own ? (
          <Link className="link" href={`/${locale}/app/ai`}>
            {a.back}
          </Link>
        ) : (
          <span>
            {a.student}: {nameOf(fb.profile_id as string)}
          </span>
        )}
        <span>{formatShortDateTime(locale, fb.created_at as string, DEFAULT_TIMEZONE)}</span>
      </p>
      <Notice tone="info">{a.limits}</Notice>

      <section aria-labelledby="in-h" className="space-y-2">
        <h2 id="in-h" className="text-xl font-bold">
          {fb.kind === 'grammar' ? a.question : a.yourText}
        </h2>
        <p className="whitespace-pre-wrap rounded-[var(--radius-control)] bg-surface-muted p-3">{fb.input as string}</p>
      </section>

      {writing?.success ? (
        <section aria-labelledby="res-h" className="space-y-3">
          <h2 id="res-h" className="text-xl font-bold">
            {a.summary}
          </h2>
          <p className="whitespace-pre-wrap">{writing.data.summary}</p>
          <h3 className="text-lg font-semibold">{a.corrections}</h3>
          {writing.data.corrections.length === 0 ? <p>{a.noCorrections}</p> : null}
          <ol className="space-y-3">
            {writing.data.corrections.map((c, i) => (
              <li key={i} className="space-y-1 rounded-[var(--radius-control)] border border-border p-3">
                <Badge>{cat(c.category)}</Badge>
                <p>
                  <span className="text-muted">{a.original}:</span> <s>{c.original}</s>
                </p>
                <p>
                  <span className="text-muted">{a.suggestion}:</span> <strong>{c.suggestion}</strong>
                </p>
                <p className="text-sm">
                  <span className="text-muted">{a.why}:</span> {c.explanation}
                </p>
              </li>
            ))}
          </ol>
          {dropped > 0 ? <p className="text-sm text-muted">{fmt(a.dropped, { count: dropped })}</p> : null}
          {writing.data.strengths.length ? (
            <>
              <h3 className="text-lg font-semibold">{a.strengths}</h3>
              <ul className="list-disc pl-6">
                {writing.data.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          ) : null}
          {writing.data.uncertainty ? (
            <p className="text-sm">
              <strong>{a.uncertainty}:</strong> {writing.data.uncertainty}
            </p>
          ) : null}
        </section>
      ) : null}

      {grammar?.success ? (
        <section aria-labelledby="gr-h" className="space-y-3">
          <h2 id="gr-h" className="sr-only">
            {a.grammarTitle}
          </h2>
          <p className="whitespace-pre-wrap">{grammar.data.explanation}</p>
          <h3 className="text-lg font-semibold">{a.examples}</h3>
          <ul className="space-y-2">
            {grammar.data.examples.map((e, i) => (
              <li key={i}>
                <strong>{e.sentence}</strong>
                {e.note ? <span className="text-muted"> — {e.note}</span> : null}
              </li>
            ))}
          </ul>
          {grammar.data.commonMistakes.length ? (
            <>
              <h3 className="text-lg font-semibold">{a.commonMistakes}</h3>
              <ul className="list-disc pl-6">
                {grammar.data.commonMistakes.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      <Disputes feedbackId={id} disputes={list} canOpen={canOpen} canResolve={canResolve === true} locale={locale} t={t} />
    </WorkspacePage>
  );
}
