import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import {
  assignAssessmentAction,
  assignTeacherAction,
  createHomeworkAction,
  enrollStudentAction,
  grantRetakeAction,
  gradeSubmissionAction,
  setEnrollmentStatusAction,
  setGroupStatusAction,
} from '@/server/lms/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function GroupPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/groups/${id}`);
  const t = getDictionary(locale);
  const g = t.lms.groups;
  const msg = authMessages(t);
  const db = await createUserClient();

  const { data: group } = await db.from('groups').select('id, organization_id, branch_id, course_id, name, capacity, status, enrollment_status').eq('id', id).maybeSingle();
  if (!group) notFound(); // RLS: чужая группа неотличима от несуществующей
  const org = group.organization_id as string;
  const branch = group.branch_id as string;
  const m = ctx.memberships;
  const canManage = can(m, 'group.manage', org, branch);
  const canEnroll = can(m, 'enrollment.manage', org, branch);

  const [teachers, enrollments, branchRow, gas, courseTests, homework] = await Promise.all([
    db.from('group_teachers').select('teacher_id').eq('group_id', id),
    db.from('enrollments').select('id, student_id, status').eq('group_id', id),
    db.from('branches').select('timezone').eq('id', branch).maybeSingle(),
    db.from('group_assessments').select('assessment_id, opens_at, due_at').eq('group_id', id),
    db.from('assessments').select('id, title, status').eq('course_id', group.course_id as string).eq('status', 'published'),
    db.from('assignments').select('id, title, due_at, max_score').eq('group_id', id).order('created_at', { ascending: false }),
  ]);
  const isTeacher = (teachers.data ?? []).some((x) => x.teacher_id === ctx.user.id);
  const tz = (branchRow.data?.timezone as string | undefined) ?? 'Asia/Bishkek';
  const studentIds = (enrollments.data ?? []).map((e) => e.student_id as string);
  const teacherIds = (teachers.data ?? []).map((x) => x.teacher_id as string);

  // Кандидаты для назначения и записи — участники филиала (видны при member.read).
  const [candidates, attempts, submissions] = await Promise.all([
    canManage || canEnroll
      ? db.from('memberships').select('profile_id, role').eq('organization_id', org).eq('branch_id', branch).eq('status', 'active').in('role', ['teacher', 'student'])
      : Promise.resolve({ data: [] as { profile_id: string; role: string }[] }),
    db.from('assessment_attempts').select('assessment_id, student_id, score, max_score').in('student_id', studentIds.length ? studentIds : ['00000000-0000-0000-0000-000000000000']),
    (homework.data ?? []).length
      ? db.from('assignment_submissions').select('id, assignment_id, student_id, body, status, score, feedback').in('assignment_id', (homework.data ?? []).map((h) => h.id as string))
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const peopleIds = [...new Set([...studentIds, ...teacherIds, ...(candidates.data ?? []).map((c) => c.profile_id as string)])];
  const { data: people } = peopleIds.length ? await db.from('profiles').select('id, full_name').in('id', peopleIds) : { data: [] };
  const nameOf = (pid: string) => ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—';
  const testTitle = (aid: string) => ((courseTests.data ?? []).find((a) => a.id === aid)?.title as string) ?? '—';
  const assigned = new Set((gas.data ?? []).map((x) => x.assessment_id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={group.name as string}>
      <p className="flex flex-wrap gap-4">
        <Link className="link" href={`/${locale}/app/groups/${id}/grades`}>
          {t.grades.gradesLink}
        </Link>
        <Link className="link" href={`/${locale}/app/groups/${id}/exams`}>
          {t.grades.examsLink}
        </Link>
      </p>
      {canManage ? (
        <ActionForm action={setGroupStatusAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="groupId" value={id} />
          <SelectField name="status" label={t.lms.common.status} defaultValue={group.status as string} idPrefix="gs">
            {(['planned', 'active', 'completed', 'cancelled'] as const).map((s) => (
              <option key={s} value={s}>
                {g.groupStatuses[s]}
              </option>
            ))}
          </SelectField>
          <SelectField name="enrollmentStatus" label={g.enrollment} defaultValue={group.enrollment_status as string} idPrefix="gs">
            {(['open', 'waitlist', 'closed'] as const).map((s) => (
              <option key={s} value={s}>
                {g.enrollmentStatuses[s]}
              </option>
            ))}
          </SelectField>
        </ActionForm>
      ) : null}

      <section aria-labelledby="teachers-h" className="space-y-3">
        <h2 id="teachers-h" className="text-xl font-bold">
          {g.teachersTitle}
        </h2>
        <p>{teacherIds.map(nameOf).join(', ') || '—'}</p>
        {canManage ? (
          <ActionForm action={assignTeacherAction} submitLabel={g.assignTeacher} pendingLabel={t.common.pending} messages={msg} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
            <input type="hidden" name="branchId" value={branch} />
            <input type="hidden" name="groupId" value={id} />
            <SelectField name="teacherId" label={g.teacher} idPrefix="gt">
              {(candidates.data ?? []).filter((c) => c.role === 'teacher' && !teacherIds.includes(c.profile_id as string)).map((c) => (
                <option key={c.profile_id as string} value={c.profile_id as string}>
                  {nameOf(c.profile_id as string)}
                </option>
              ))}
            </SelectField>
          </ActionForm>
        ) : null}
      </section>

      <section aria-labelledby="students-h" className="space-y-3">
        <h2 id="students-h" className="text-xl font-bold">
          {g.studentsTitle}
        </h2>
        <ul className="space-y-2">
          {(enrollments.data ?? []).map((e) => (
            <li key={e.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <span>
                {nameOf(e.student_id as string)} <Badge>{g.enrollmentStates[e.status as 'active']}</Badge>
              </span>
              {canEnroll ? (
                <ActionForm action={setEnrollmentStatusAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} variant="secondary" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="enrollmentId" value={e.id as string} />
                  <SelectField name="status" label={t.lms.common.status} defaultValue={e.status as string} idPrefix={`en-${e.id as string}`}>
                    {(['pending', 'active', 'paused', 'completed', 'cancelled'] as const).map((s) => (
                      <option key={s} value={s}>
                        {g.enrollmentStates[s]}
                      </option>
                    ))}
                  </SelectField>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
        {canEnroll ? (
          (() => {
            const free = (candidates.data ?? []).filter((c) => c.role === 'student' && !studentIds.includes(c.profile_id as string));
            return free.length === 0 ? (
              <p className="text-muted">{g.noStudentsToEnroll}</p>
            ) : (
              <ActionForm action={enrollStudentAction} submitLabel={g.enroll} pendingLabel={t.common.pending} messages={msg} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="organizationId" value={org} />
                <input type="hidden" name="branchId" value={branch} />
                <input type="hidden" name="groupId" value={id} />
                <SelectField name="studentId" label={g.student} idPrefix="ge">
                  {free.map((c) => (
                    <option key={c.profile_id as string} value={c.profile_id as string}>
                      {nameOf(c.profile_id as string)}
                    </option>
                  ))}
                </SelectField>
              </ActionForm>
            );
          })()
        ) : null}
      </section>

      <section aria-labelledby="tests-h" className="space-y-3">
        <h2 id="tests-h" className="text-xl font-bold">
          {g.testsTitle}
        </h2>
        <ul className="space-y-2">
          {(gas.data ?? []).map((x) => (
            <li key={x.assessment_id as string} className="rounded-[var(--radius-control)] border border-border px-3 py-2">
              {testTitle(x.assessment_id as string)} · {formatDateTime(locale, x.opens_at as string, tz)}
              {x.due_at ? ` → ${formatDateTime(locale, x.due_at as string, tz)}` : ''}
            </li>
          ))}
        </ul>
        {isTeacher || canManage ? (
          <ActionForm action={assignAssessmentAction} submitLabel={g.assignTest} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ opensAt: g.opensAt, dueAt: g.dueAt }} className="grid gap-3 sm:grid-cols-3 sm:items-end">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={org} />
            <input type="hidden" name="branchId" value={branch} />
            <input type="hidden" name="groupId" value={id} />
            <SelectField name="assessmentId" label={g.test} idPrefix="ga">
              {(courseTests.data ?? []).map((a) => (
                <option key={a.id as string} value={a.id as string}>
                  {a.title as string}
                  {assigned.has(a.id as string) ? ' ✓' : ''}
                </option>
              ))}
            </SelectField>
            <Field name="opensAt" type="datetime-local" label={`${g.opensAt} (${tz})`} required idPrefix="ga" />
            <Field name="dueAt" type="datetime-local" label={`${g.dueAt} (${tz})`} idPrefix="ga" />
          </ActionForm>
        ) : null}
      </section>

      <section aria-labelledby="results-h" className="space-y-3">
        <h2 id="results-h" className="text-xl font-bold">
          {g.resultsTitle}
        </h2>
        {(attempts.data ?? []).length === 0 ? (
          <p className="text-muted">{g.noResults}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border-strong">
                  <th scope="col" className="py-2 pr-3">{g.student}</th>
                  <th scope="col" className="py-2 pr-3">{g.test}</th>
                  <th scope="col" className="py-2 pr-3">{g.attempts}</th>
                  <th scope="col" className="py-2 pr-3">{g.best}</th>
                  <th scope="col" className="py-2"><span className="sr-only">{g.grantRetake}</span></th>
                </tr>
              </thead>
              <tbody>
                {[...new Set((attempts.data ?? []).filter((a) => assigned.has(a.assessment_id as string)).map((a) => `${a.student_id as string}|${a.assessment_id as string}`))].map((k) => {
                  const [sid, aid] = k.split('|') as [string, string];
                  const rowsFor = (attempts.data ?? []).filter((a) => a.student_id === sid && a.assessment_id === aid);
                  const best = rowsFor.reduce((b, a) => (Number(a.score) > Number(b.score) ? a : b), rowsFor[0]!);
                  return (
                    <tr key={k} className="border-b border-border align-top">
                      <td className="py-2 pr-3">{nameOf(sid)}</td>
                      <td className="py-2 pr-3">{testTitle(aid)}</td>
                      <td className="py-2 pr-3">{rowsFor.length}</td>
                      <td className="py-2 pr-3">
                        {String(best.score)} / {String(best.max_score)}
                      </td>
                      <td className="py-2">
                        {isTeacher ? (
                          <ActionForm action={grantRetakeAction} submitLabel={g.grantRetake} pendingLabel={t.common.pending} messages={msg} variant="secondary" className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="organizationId" value={org} />
                            <input type="hidden" name="assessmentId" value={aid} />
                            <input type="hidden" name="studentId" value={sid} />
                            <Field name="reason" label={g.retakeReason} idPrefix={`rt-${k}`} />
                          </ActionForm>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="hw-h" className="space-y-3">
        <h2 id="hw-h" className="text-xl font-bold">
          {g.homeworkTitle}
        </h2>
        {(homework.data ?? []).length === 0 ? <EmptyState title={g.noSubmissions} /> : null}
        {(homework.data ?? []).map((hw) => {
          const subs = (submissions.data ?? []).filter((s) => s.assignment_id === hw.id);
          return (
            <details key={hw.id as string} className="rounded-[var(--radius-card)] border border-border p-4">
              <summary className="cursor-pointer font-medium">
                {hw.title as string} · {subs.length}
                {hw.due_at ? ` · ${formatDateTime(locale, hw.due_at as string, tz)}` : ''}
              </summary>
              {subs.length === 0 ? <p className="mt-2 text-muted">{g.noSubmissions}</p> : null}
              <ul className="mt-3 space-y-4">
                {subs.map((s) => (
                  <li key={s.id as string} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
                    <p className="font-medium">
                      {nameOf(s.student_id as string)} <Badge>{t.lms.learn.homeworkStatuses[s.status as 'submitted']}</Badge>
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{s.body as string}</p>
                    {isTeacher ? (
                      <ActionForm action={gradeSubmissionAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ score: g.score }} className="grid gap-2 sm:grid-cols-3 sm:items-end">
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="submissionId" value={s.id as string} />
                        <SelectField name="decision" label={g.decision} idPrefix={`gr-${s.id as string}`}>
                          <option value="graded">{g.grade}</option>
                          <option value="returned">{g.returnWork}</option>
                        </SelectField>
                        <Field name="score" inputMode="decimal" label={`${g.score} (max ${String(hw.max_score)})`} defaultValue={(s.score as string | null) ?? ''} idPrefix={`gr-${s.id as string}`} />
                        <TextareaField name="feedback" label={g.feedback} defaultValue={(s.feedback as string | null) ?? ''} rows={2} idPrefix={`gr-${s.id as string}`} />
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
        {isTeacher ? (
          <details className="rounded-[var(--radius-card)] border border-border p-4">
            <summary className="cursor-pointer font-medium">{g.newHomework}</summary>
            <ActionForm action={createHomeworkAction} submitLabel={t.lms.common.create} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: t.lms.common.title, maxScore: g.maxScore }} className="mt-3 space-y-3">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="organizationId" value={org} />
              <input type="hidden" name="branchId" value={branch} />
              <input type="hidden" name="groupId" value={id} />
              <Field name="title" label={t.lms.common.title} required idPrefix="hw" />
              <TextareaField name="instructions" label={g.instructions} idPrefix="hw" />
              <Field name="dueAt" type="datetime-local" label={`${g.dueAt} (${tz})`} idPrefix="hw" />
              <Field name="maxScore" inputMode="decimal" label={g.maxScore} defaultValue="10" idPrefix="hw" />
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{g.forStudents}</legend>
                <p className="text-sm text-muted">{g.forStudentsHint}</p>
                {(enrollments.data ?? [])
                  .filter((e) => e.status === 'active')
                  .map((e) => (
                    <label key={e.student_id as string} className="flex items-start gap-3 text-sm">
                      <input type="checkbox" name="student" value={e.student_id as string} className="mt-0.5 size-5 shrink-0 accent-brand-700" />
                      <span>{nameOf(e.student_id as string)}</span>
                    </label>
                  ))}
              </fieldset>
            </ActionForm>
          </details>
        ) : null}
      </section>
    </WorkspacePage>
  );
}
