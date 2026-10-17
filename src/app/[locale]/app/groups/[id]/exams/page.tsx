import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckboxField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { createExamAction, publishExamAction, saveExamResultsAction, setTestAsExamAction } from '@/server/grading/actions';
import { localDate } from '@/server/management/period';
import { createUserClient } from '@/server/supabase/server';

export default async function ExamsPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/groups/${id}/exams`);
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

  const [{ data: teacherRow }, { data: exams }, { data: enrollments }, { data: tests }] = await Promise.all([
    db.from('group_teachers').select('teacher_id').eq('group_id', id).eq('teacher_id', ctx.user.id).maybeSingle(),
    db.from('group_exams').select('id, title, held_on, max_score, status').eq('group_id', id).order('held_on', { ascending: false }),
    db.from('enrollments').select('student_id').eq('group_id', id).in('status', ['active', 'completed']),
    db.from('group_assessments').select('assessment_id, due_at, counts_as_exam, assessments(title)').eq('group_id', id),
  ]);
  const isTeacher = Boolean(teacherRow);
  const allowed = isTeacher || can(m, 'learning.read_all', org, branch) || can(m, 'group.manage', org, branch);
  const examIds = (exams ?? []).map((e) => e.id as string);
  const { data: results } = examIds.length ? await db.from('exam_results').select('exam_id, student_id, score, absent').in('exam_id', examIds) : { data: [] };
  const studentIds = [...new Set((enrollments ?? []).map((e) => e.student_id as string))];
  const { data: people } = studentIds.length ? await db.from('profiles').select('id, full_name').in('id', studentIds) : { data: [] };
  const nameOf = (pid: string) => ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—';
  studentIds.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const resultOf = (exam: string, sid: string) => (results ?? []).find((r) => r.exam_id === exam && r.student_id === sid);

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${gr.examsTitle}: ${group.name as string}`} allowed={allowed}>
      <p className="flex flex-wrap gap-4">
        <Link className="link" href={`/${locale}/app/groups/${id}`}>
          {gr.back}
        </Link>
        <Link className="link" href={`/${locale}/app/groups/${id}/grades`}>
          {gr.gradesLink}
        </Link>
      </p>

      {isTeacher ? (
        <Card>
          <h2 className="mb-3 text-xl font-bold">{gr.newExam}</h2>
          <ActionForm action={createExamAction} submitLabel={gr.createExam} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: gr.examTitle, heldOn: gr.heldOn, maxScore: gr.maxScore }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
            <input type="hidden" name="branchId" value={branch} />
            <input type="hidden" name="groupId" value={id} />
            <Field name="title" label={gr.examTitle} required minLength={2} maxLength={200} idPrefix="ne" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="heldOn" type="date" label={gr.heldOn} required defaultValue={localDate(tz)} idPrefix="ne" />
              <Field name="maxScore" inputMode="decimal" label={gr.maxScore} required defaultValue="100" idPrefix="ne" />
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {(exams ?? []).length === 0 ? <EmptyState title={gr.noExams} /> : null}
      {(exams ?? []).map((e) => {
        const eid = e.id as string;
        const published = e.status === 'published';
        return (
          <section key={eid} aria-labelledby={`ex-${eid}`} className="space-y-3 rounded-[var(--radius-card)] border border-border p-4">
            <h2 id={`ex-${eid}`} className="flex flex-wrap items-center gap-2 text-lg font-bold">
              {e.title as string}
              <Badge tone={published ? 'success' : 'neutral'}>{gr.statuses[published ? 'published' : 'draft']}</Badge>
            </h2>
            <p className="text-sm text-muted">
              {formatDate(locale, e.held_on as string)} · {gr.maxScore}: {String(e.max_score)}
            </p>
            {isTeacher ? (
              <ActionForm action={saveExamResultsAction} submitLabel={gr.saveResults} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ score: gr.score }}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="examId" value={eid} />
                <input type="hidden" name="organizationId" value={org} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-left text-sm">
                    <thead>
                      <tr className="border-b border-border-strong">
                        <th scope="col" className="py-2 pr-3">{gr.student}</th>
                        <th scope="col" className="py-2 pr-3">{gr.score}</th>
                        <th scope="col" className="py-2">{gr.absent}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {studentIds.map((sid) => {
                        const r = resultOf(eid, sid);
                        return (
                          <tr key={sid} className="border-b border-border">
                            <th scope="row" className="py-2 pr-3 font-normal">
                              {nameOf(sid)}
                            </th>
                            <td className="py-2 pr-3">
                              <label htmlFor={`s-${eid}-${sid}`} className="sr-only">
                                {gr.score}: {nameOf(sid)}
                              </label>
                              <input
                                id={`s-${eid}-${sid}`}
                                name={`score:${sid}`}
                                inputMode="decimal"
                                defaultValue={r?.score === null || r?.score === undefined ? '' : String(r.score)}
                                className="min-h-11 w-24 rounded-[var(--radius-control)] border border-border-strong bg-surface px-3"
                              />
                            </td>
                            <td className="py-2">
                              <label htmlFor={`a-${eid}-${sid}`} className="sr-only">
                                {gr.absent}: {nameOf(sid)}
                              </label>
                              <input id={`a-${eid}-${sid}`} type="checkbox" name={`absent:${sid}`} defaultChecked={Boolean(r?.absent)} className="size-5 accent-brand-700" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </ActionForm>
            ) : (
              <ul className="text-sm">
                {studentIds.map((sid) => {
                  const r = resultOf(eid, sid);
                  return (
                    <li key={sid}>
                      {nameOf(sid)}: {r ? (r.absent ? gr.absent : `${String(r.score)} / ${String(e.max_score)}`) : '—'}
                    </li>
                  );
                })}
              </ul>
            )}
            {isTeacher && !published ? (
              <>
                <p className="text-sm text-muted">{gr.examPublishHint}</p>
                <ActionForm action={publishExamAction} submitLabel={gr.publishExam} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="examId" value={eid} />
                </ActionForm>
              </>
            ) : null}
          </section>
        );
      })}

      <section aria-labelledby="online-h" className="space-y-3">
        <h2 id="online-h" className="text-xl font-bold">
          {gr.onlineTitle}
        </h2>
        {(tests ?? []).length === 0 ? <p className="text-muted">{gr.noTests}</p> : null}
        <ul className="space-y-2">
          {(tests ?? []).map((ga) => (
            <li key={ga.assessment_id as string} className="rounded-[var(--radius-control)] border border-border px-3 py-2">
              {isTeacher ? (
                <ActionForm action={setTestAsExamAction} submitLabel={gr.save} pendingLabel={t.common.pending} messages={msg} variant="secondary" className="flex flex-wrap items-center gap-4">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="groupId" value={id} />
                  <input type="hidden" name="assessmentId" value={ga.assessment_id as string} />
                  <span className="font-medium">{(ga.assessments as unknown as { title: string } | null)?.title ?? '—'}</span>
                  <CheckboxField name="countsAsExam" label={gr.countsAsExam} defaultChecked={Boolean(ga.counts_as_exam)} idPrefix={`ce-${ga.assessment_id as string}`} />
                </ActionForm>
              ) : (
                <p>
                  {(ga.assessments as unknown as { title: string } | null)?.title ?? '—'}
                  {ga.counts_as_exam ? ` · ${gr.countsAsExam}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </WorkspacePage>
  );
}
