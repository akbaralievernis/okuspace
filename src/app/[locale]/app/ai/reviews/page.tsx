import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

/** Открытые споры по AI-оценкам учеников, которых видит пользователь (RLS). */
export default async function AiReviewsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/ai/reviews`);
  const t = getDictionary(locale);
  const a = t.ai;
  const db = await createUserClient();
  const { data: disputes } = await db
    .from('ai_feedback_disputes')
    .select('id, comment, created_at, feedback_id, ai_feedback!inner(id, kind, profile_id)')
    .eq('status', 'open')
    .order('created_at')
    .limit(200);
  type Row = { id: string; comment: string; created_at: string; feedback_id: string; ai_feedback: { kind: string; profile_id: string } | { kind: string; profile_id: string }[] };
  const rows = ((disputes ?? []) as unknown as Row[])
    .map((d) => ({ ...d, fb: Array.isArray(d.ai_feedback) ? d.ai_feedback[0]! : d.ai_feedback }))
    .filter((d) => d.fb.profile_id !== ctx.user.id);
  const ids = [...new Set(rows.map((d) => d.fb.profile_id))];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (pid: string) => ((names ?? []).find((p) => p.id === pid)?.full_name as string) || '—';

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={a.reviewsTitle}>
      <p>
        <Link className="link" href={`/${locale}/app/ai`}>
          {a.back}
        </Link>
      </p>
      {rows.length === 0 ? (
        <EmptyState title={a.noReviews} />
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li key={d.id} className="space-y-1 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <p>
                <strong>{nameOf(d.fb.profile_id)}</strong> · {a.kinds[d.fb.kind as 'grammar']} · <span className="text-sm text-muted">{formatShortDateTime(locale, d.created_at, DEFAULT_TIMEZONE)}</span>
              </p>
              <p className="whitespace-pre-wrap text-sm">{d.comment}</p>
              <Link className="link" href={`/${locale}/app/ai/${d.fb.kind === 'exercises' ? 'practice' : 'feedback'}/${d.feedback_id}`}>
                {a.open}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}
