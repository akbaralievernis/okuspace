import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TextareaField } from '@/components/ui/controls';
import { Badge, Card, Notice } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { submitHomeworkAction } from '@/server/lms/actions';
import { createUserClient } from '@/server/supabase/server';

type Props = { params: Promise<{ locale: string; assignmentId: string }>; searchParams: Promise<{ student?: string }> };

export default async function HomeworkPage({ params, searchParams }: Props) {
  const { locale, assignmentId } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(assignmentId)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn/homework/${assignmentId}`);
  const t = getDictionary(locale);
  const l = t.lms.learn;
  const requested = (await searchParams).student;
  const studentId = requested && /^[0-9a-f-]{36}$/i.test(requested) ? requested : ctx.user.id;
  const own = studentId === ctx.user.id;

  const db = await createUserClient();
  const { data: hw } = await db
    .from('assignments')
    .select('id, organization_id, branch_id, group_id, title, instructions, due_at, max_score, status, groups(course_id, branches(timezone))')
    .eq('id', assignmentId)
    .maybeSingle();
  if (!hw || hw.status === 'draft') notFound();
  // Родитель видит работу ребёнка только если RLS отдаёт её строку; чужую — нет.
  const { data: sub } = await db.from('assignment_submissions').select('body, status, score, feedback, submitted_at').eq('assignment_id', assignmentId).eq('student_id', studentId).maybeSingle();
  if (!own && !sub) notFound();
  const one = <T,>(v: T | T[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
  type GroupRow = { course_id: string; branches: { timezone: string } | { timezone: string }[] | null };
  const group = one(hw.groups as GroupRow | GroupRow[] | null);
  const courseId = group?.course_id;
  const tz = one(group?.branches)?.timezone ?? DEFAULT_TIMEZONE;
  const canSubmit = own && hw.status === 'published' && sub?.status !== 'graded';

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={hw.title as string}>
      {courseId ? (
        <p>
          <Link className="link" href={`/${locale}/app/learn/${courseId}${own ? '' : `?student=${studentId}`}`}>
            {l.outline}
          </Link>
        </p>
      ) : null}
      <p className="text-sm text-muted">
        {hw.due_at ? fmt(l.due, { date: formatDateTime(locale, hw.due_at as string, tz) }) : l.noDue} · {fmt(l.maxPoints, { max: String(hw.max_score) })}
      </p>
      {hw.instructions ? <RichText text={hw.instructions as string} /> : null}

      {sub ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={sub.status === 'graded' ? 'success' : sub.status === 'returned' ? 'warning' : 'neutral'}>{l.homeworkStatuses[sub.status as 'submitted']}</Badge>
            <span className="text-sm text-muted">{formatDateTime(locale, sub.submitted_at as string, tz)}</span>
            {sub.status === 'graded' ? <strong>{fmt(l.homeworkScore, { score: String(sub.score), max: String(hw.max_score) })}</strong> : null}
          </div>
          {sub.feedback ? (
            <div>
              <h2 className="text-sm font-semibold">{l.feedback}</h2>
              <RichText text={sub.feedback as string} />
            </div>
          ) : null}
          {!canSubmit ? (
            <div>
              <h2 className="text-sm font-semibold">{l.yourWork}</h2>
              <p className="whitespace-pre-wrap">{sub.body as string}</p>
            </div>
          ) : null}
        </Card>
      ) : null}

      {canSubmit ? (
        <ActionForm action={submitHomeworkAction} submitLabel={l.submitHomework} pendingLabel={t.common.pending} messages={authMessages(t)} fieldLabels={{ body: l.yourWork }}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <input type="hidden" name="organizationId" value={hw.organization_id as string} />
          <input type="hidden" name="branchId" value={hw.branch_id as string} />
          <TextareaField name="body" label={l.yourWork} required rows={10} maxLength={50000} defaultValue={(sub?.body as string | undefined) ?? ''} idPrefix="hw" />
        </ActionForm>
      ) : own && sub?.status === 'graded' ? (
        <Notice tone="info">{l.gradedLocked}</Notice>
      ) : null}
    </WorkspacePage>
  );
}
