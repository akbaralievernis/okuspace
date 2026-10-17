import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, EmptyState } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { pctText } from '@/server/grading/month';
import { createUserClient } from '@/server/supabase/server';

/** Ученик видит свои итоги и экзамены, родитель — своих детей (RLS: только опубликованное). */
export default async function MyReportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn/reports`);
  const t = getDictionary(locale);
  const gr = t.grades;
  const db = await createUserClient();
  const [{ data: cards }, { data: results }] = await Promise.all([
    db
      .from('report_cards')
      .select('id, student_id, month, attendance_pct, homework_pct, tests_pct, exam_pct, final_pct, grade, teacher_comment, groups(name)')
      .eq('status', 'published')
      .order('month', { ascending: false })
      .limit(60),
    db.from('exam_results').select('exam_id, student_id, score, absent, group_exams(title, held_on, max_score, status)').limit(100),
  ]);
  const visibleResults = (results ?? [])
    .map((r) => ({ ...r, exam: r.group_exams as unknown as { title: string; held_on: string; max_score: string; status: string } | null }))
    .filter((r) => r.exam?.status === 'published')
    .sort((a, b) => b.exam!.held_on.localeCompare(a.exam!.held_on));
  const ids = [...new Set([...(cards ?? []).map((c) => c.student_id as string), ...visibleResults.map((r) => r.student_id as string)])];
  const { data: people } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (pid: string) => ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—';
  const others = ids.some((x) => x !== ctx.user.id); // родитель: показываем, чей результат

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={gr.myTitle}>
      <p>
        <Link className="link" href={`/${locale}/app/learn`}>
          {t.lms.learn.title}
        </Link>
      </p>
      {(cards ?? []).length === 0 ? (
        <EmptyState title={gr.myNone} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {(cards ?? []).map((c) => (
            <li key={c.id as string}>
              <Card className="space-y-2">
                <h2 className="text-lg font-semibold">
                  {String(c.month).slice(0, 7)} · {(c.groups as unknown as { name: string } | null)?.name ?? ''}
                </h2>
                {others ? (
                  <p className="text-sm text-muted">
                    {gr.forWhom}: {nameOf(c.student_id as string)}
                  </p>
                ) : null}
                <p className="text-2xl font-bold">
                  {c.grade ? `${String(c.grade)} · ` : ''}
                  {pctText(c.final_pct)}
                </p>
                <dl className="grid grid-cols-2 gap-x-4 text-sm">
                  <dt className="text-muted">{gr.attendance}</dt>
                  <dd>{pctText(c.attendance_pct)}</dd>
                  <dt className="text-muted">{gr.homework}</dt>
                  <dd>{pctText(c.homework_pct)}</dd>
                  <dt className="text-muted">{gr.tests}</dt>
                  <dd>{pctText(c.tests_pct)}</dd>
                  <dt className="text-muted">{gr.exam}</dt>
                  <dd>{pctText(c.exam_pct)}</dd>
                </dl>
                {c.teacher_comment ? (
                  <p className="text-sm">
                    <span className="text-muted">{gr.comment}: </span>
                    {c.teacher_comment as string}
                  </p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="ex-h" className="space-y-3">
        <h2 id="ex-h" className="text-xl font-bold">
          {gr.examResults}
        </h2>
        {visibleResults.length === 0 ? (
          <p className="text-muted">{gr.noResults}</p>
        ) : (
          <ul className="space-y-2">
            {visibleResults.map((r) => (
              <li key={`${r.exam_id as string}-${r.student_id as string}`} className="rounded-[var(--radius-control)] border border-border px-3 py-2">
                <p className="font-medium">{r.exam!.title}</p>
                <p className="text-sm text-muted">
                  {formatDate(locale, r.exam!.held_on)}
                  {others ? ` · ${nameOf(r.student_id as string)}` : ''} ·{' '}
                  {r.absent ? gr.absent : `${String(r.score ?? '—')} / ${String(r.exam!.max_score)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">{gr.definitionsTitle}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          {gr.definitions.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
    </WorkspacePage>
  );
}
