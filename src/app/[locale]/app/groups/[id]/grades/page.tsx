import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { publishReportsAction, recomputeReportsAction, reportCommentAction } from '@/server/grading/actions';
import { pctText, recentMonths, reportMonth } from '@/server/grading/month';
import { createUserClient } from '@/server/supabase/server';

interface Card {
  id: string;
  student_id: string;
  attendance_pct: string | null;
  homework_pct: string | null;
  tests_pct: string | null;
  exam_pct: string | null;
  final_pct: string | null;
  grade: number | null;
  status: 'draft' | 'published';
  teacher_comment: string | null;
  weights: { attendance: number; homework: number; tests: number; exam: number; scale: string };
}

export default async function GradesPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ month?: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/groups/${id}/grades`);
  const t = getDictionary(locale);
  const gr = t.grades;
  const msg = authMessages(t);
  const db = await createUserClient();
  const { data: group } = await db.from('groups').select('id, organization_id, branch_id, name, branches(timezone)').eq('id', id).maybeSingle();
  if (!group) notFound();
  const org = group.organization_id as string;
  const branch = group.branch_id as string;
  const tz = (group.branches as unknown as { timezone: string } | null)?.timezone ?? DEFAULT_TIMEZONE;
  const m = ctx.memberships;
  const { data: teacherRow } = await db.from('group_teachers').select('teacher_id').eq('group_id', id).eq('teacher_id', ctx.user.id).maybeSingle();
  const canEdit = Boolean(teacherRow) || can(m, 'group.manage', org, branch);
  const allowed = canEdit || can(m, 'learning.read_all', org, branch);
  const month = reportMonth((await searchParams).month, tz);

  const { data } = await db
    .from('report_cards')
    .select('id, student_id, attendance_pct, homework_pct, tests_pct, exam_pct, final_pct, grade, status, teacher_comment, weights')
    .eq('group_id', id)
    .eq('month', `${month}-01`);
  const cards = (data ?? []) as Card[];
  const { data: people } = cards.length ? await db.from('profiles').select('id, full_name').in('id', cards.map((c) => c.student_id)) : { data: [] };
  const nameOf = (pid: string) => ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—';
  cards.sort((a, b) => nameOf(a.student_id).localeCompare(nameOf(b.student_id)));
  const drafts = cards.filter((c) => c.status === 'draft').length;
  const w = cards[0]?.weights;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="groupId" value={id} />
      <input type="hidden" name="month" value={month} />
    </>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${gr.title}: ${group.name as string}`} allowed={allowed}>
      <p className="flex flex-wrap gap-4">
        <Link className="link" href={`/${locale}/app/groups/${id}`}>
          {gr.back}
        </Link>
        <Link className="link" href={`/${locale}/app/groups/${id}/exams`}>
          {gr.examsLink}
        </Link>
      </p>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <SelectField name="month" label={gr.month} defaultValue={month} idPrefix="gm">
          {recentMonths(tz).map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </SelectField>
        <button type="submit" className="min-h-11 rounded-[var(--radius-control)] border border-border-strong px-4">
          {gr.show}
        </button>
      </form>

      {canEdit ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{gr.recomputeHint}</p>
          <div className="flex flex-wrap gap-3">
            <ActionForm action={recomputeReportsAction} submitLabel={gr.recompute} pendingLabel={t.common.pending} messages={msg} variant="secondary">
              {hidden}
            </ActionForm>
            {drafts > 0 ? (
              <ActionForm
                action={publishReportsAction}
                submitLabel={gr.publish}
                pendingLabel={t.common.pending}
                messages={msg}
                confirm={{ title: gr.publish, text: gr.publishConfirm, confirmLabel: gr.publish, cancelLabel: gr.keep }}
              >
                {hidden}
              </ActionForm>
            ) : null}
          </div>
          {drafts > 0 ? <p className="text-sm text-muted">{gr.publishHint}</p> : null}
        </div>
      ) : null}

      {cards.length === 0 ? (
        <EmptyState title={gr.none} />
      ) : (
        <>
          {w ? <p className="text-sm">{fmt(gr.weights, { attendance: String(w.attendance), homework: String(w.homework), tests: String(w.tests), exam: String(w.exam) })}</p> : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <caption className="sr-only">
                {gr.title} {month}
              </caption>
              <thead>
                <tr className="border-b border-border-strong">
                  {[gr.student, gr.attendance, gr.homework, gr.tests, gr.exam, gr.final, gr.grade, gr.status].map((h) => (
                    <th key={h} scope="col" className="py-2 pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id} className="border-b border-border align-top">
                    <th scope="row" className="py-2 pr-3 font-normal">
                      {nameOf(c.student_id)}
                      {canEdit && c.status === 'draft' ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-muted">{gr.comment}</summary>
                          <ActionForm action={reportCommentAction} submitLabel={gr.saveComment} pendingLabel={t.common.pending} messages={msg} variant="secondary" className="mt-2 space-y-2">
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="reportId" value={c.id} />
                            <TextareaField name="comment" label={gr.comment} defaultValue={c.teacher_comment ?? ''} rows={2} maxLength={2000} idPrefix={`rc-${c.id}`} />
                          </ActionForm>
                        </details>
                      ) : c.teacher_comment ? (
                        <p className="mt-1 text-muted">{c.teacher_comment}</p>
                      ) : null}
                    </th>
                    <td className="py-2 pr-3 tabular-nums">{pctText(c.attendance_pct)}</td>
                    <td className="py-2 pr-3 tabular-nums">{pctText(c.homework_pct)}</td>
                    <td className="py-2 pr-3 tabular-nums">{pctText(c.tests_pct)}</td>
                    <td className="py-2 pr-3 tabular-nums">{pctText(c.exam_pct)}</td>
                    <td className="py-2 pr-3 font-semibold tabular-nums">{pctText(c.final_pct)}</td>
                    <td className="py-2 pr-3 font-semibold">{c.grade ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={c.status === 'published' ? 'success' : 'neutral'}>{gr.statuses[c.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
