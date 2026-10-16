import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatDateTime, formatShortDateTime, formatTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { cancelSessionAction, confirmCameraEventAction, markAttendanceAction, openCodeAction, rescheduleAction } from '@/server/schedule/actions';
import { ABSENCE_REASONS, ATTENDANCE_STATUSES, localDate, markingWindow, parsePeriod } from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

const MIN = 60_000;
const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));

type Rec = { id: string; student_id: string; status: string; minutes_late: number | null; absence_reason: string | null; note: string | null; source: string };

export default async function SessionPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/schedule/sessions/${id}`);
  const t = getDictionary(locale);
  const s = t.schedule;
  const msg = authMessages(t);
  const db = await createUserClient();

  // RLS: чужое занятие неотличимо от несуществующего.
  const { data: row } = await db
    .from('lesson_sessions')
    .select('id, organization_id, branch_id, group_id, teacher_id, classroom_id, online_url, period, status, topic, cancel_reason, groups(name, branches(timezone)), classrooms(name)')
    .eq('id', id)
    .maybeSingle();
  if (!row) notFound();
  const group = one(row.groups as unknown as { name: string; branches: { timezone: string } | { timezone: string }[] } | null);
  const tz = one(group?.branches)?.timezone ?? DEFAULT_TIMEZONE;
  const [startIso, endIso] = parsePeriod(row.period as string);
  const org = row.organization_id as string;
  const branch = row.branch_id as string;
  const status = row.status as 'scheduled' | 'done' | 'cancelled';
  const cancelled = status === 'cancelled';
  const m = ctx.memberships;
  const win = markingWindow(startIso, endIso);

  const [teachers, enrollments, records, history, events, changes, rooms] = await Promise.all([
    db.from('group_teachers').select('teacher_id').eq('group_id', row.group_id as string),
    db.from('enrollments').select('student_id, status').eq('group_id', row.group_id as string).in('status', ['active', 'paused', 'completed']),
    db.from('attendance_records').select('id, student_id, status, minutes_late, absence_reason, note, source').eq('session_id', id),
    db.from('attendance_record_history').select('id, student_id, status, minutes_late, absence_reason, source, reason, changed_by, changed_at').eq('session_id', id).order('id'),
    db.from('attendance_events').select('id, student_id, source, kind, occurred_at, confidence').eq('session_id', id).eq('source', 'camera').order('occurred_at'),
    db.from('lesson_session_changes').select('id, kinds, note, created_at').eq('session_id', id).order('created_at', { ascending: false }),
    db.from('classrooms').select('id, name').eq('branch_id', branch).eq('status', 'active').order('name'),
  ]);

  const isTeacher = row.teacher_id === ctx.user.id || (teachers.data ?? []).some((x) => x.teacher_id === ctx.user.id);
  const canSchedule = can(m, 'schedule.manage', org, branch);
  const canCorrect = can(m, 'attendance.manage', org, branch);
  const opened = win.opened;
  const teacherWindow = isTeacher && win.teacherOpen;
  // Окончательное решение принимает БД (mark_attendance); здесь — только какую форму показать.
  const canMark = !cancelled && (teacherWindow || (canCorrect && opened));
  const staffCorrection = canMark && !teacherWindow;

  const recs = (records.data ?? []) as Rec[];
  const studentIds = (enrollments.data ?? []).map((e) => e.student_id as string);
  const peopleIds = [...new Set([...studentIds, ...recs.map((r) => r.student_id), row.teacher_id as string, ...(history.data ?? []).map((h) => h.changed_by as string).filter(Boolean)])];
  const { data: people } = await db.from('profiles').select('id, full_name').in('id', peopleIds);
  const nameOf = (pid: string | null) => (pid ? ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—' : '—');
  const recOf = (sid: string) => recs.find((r) => r.student_id === sid);
  const confirmedEvents = new Set<string>();
  const { data: evidence } = await db.from('attendance_records').select('evidence_event_id').eq('session_id', id).not('evidence_event_id', 'is', null);
  for (const e of evidence ?? []) confirmedEvents.add(e.evidence_event_id as string);
  const pendingCamera = (events.data ?? []).filter((e) => !confirmedEvents.has(e.id as string));
  const roster = isTeacher || canCorrect || can(m, 'group.read', org, branch);
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / MIN);
  const localTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(startIso));
  const classroomName = one(row.classrooms as unknown as { name: string } | null)?.name;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${group?.name ?? s.sessionTitle} · ${formatShortDateTime(locale, startIso, tz)}`}>
      <p>
        <Link className="link" href={`/${locale}/app/schedule?week=${localDate(startIso, tz)}`}>
          {s.title}
        </Link>
      </p>

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="font-semibold">{s.when}</dt>
        <dd>
          {formatDateTime(locale, startIso, tz)} – {formatTime(locale, endIso, tz)}
        </dd>
        <dt className="font-semibold">{s.teacher}</dt>
        <dd>{nameOf(row.teacher_id as string)}</dd>
        <dt className="font-semibold">{s.place}</dt>
        <dd>
          {classroomName ?? s.online}
          {row.online_url && !cancelled ? (
            <>
              {' · '}
              <a className="link" href={row.online_url as string} target="_blank" rel="noopener noreferrer">
                {s.join}
              </a>
            </>
          ) : null}
        </dd>
        {row.topic ? (
          <>
            <dt className="font-semibold">{s.topic}</dt>
            <dd>{row.topic as string}</dd>
          </>
        ) : null}
        <dt className="font-semibold">{s.status}</dt>
        <dd>
          <Badge tone={cancelled ? 'warning' : status === 'done' ? 'success' : 'neutral'}>{s.statuses[status]}</Badge>
        </dd>
        {cancelled && row.cancel_reason ? (
          <>
            <dt className="font-semibold">{s.cancelReason}</dt>
            <dd>{row.cancel_reason as string}</dd>
          </>
        ) : null}
      </dl>

      {/* Ученик и родитель: RLS отдаёт только свои отметки и отметки ребёнка. */}
      {!roster && recs.length ? (
        <ul className="space-y-1">
          {recs.map((r) => (
            <li key={r.id}>
              {r.student_id === ctx.user.id
                ? fmt(s.yourMark, { status: s.attendance[r.status as 'present'] })
                : fmt(s.childMark, { name: nameOf(r.student_id), status: s.attendance[r.status as 'present'] })}
            </li>
          ))}
        </ul>
      ) : null}

      {roster && !cancelled ? (
        <section aria-labelledby="att-h" className="space-y-4">
          <h2 id="att-h" className="text-xl font-bold">
            {s.attendanceTitle}
          </h2>
          {!opened ? <Notice tone="info">{s.notYet}</Notice> : null}
          {isTeacher && opened && !teacherWindow && !canCorrect ? <Notice tone="info">{s.windowClosed}</Notice> : null}
          {studentIds.length === 0 ? <p className="text-muted">{s.noStudents}</p> : null}
          {canMark && studentIds.length ? (
            <ActionForm action={markAttendanceAction} submitLabel={s.saveMarks} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ reason: s.correctionReason, marks: s.attendanceTitle }}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="sessionId" value={id} />
              <ul className="space-y-3">
                {studentIds.map((sid) => {
                  const r = recOf(sid);
                  return (
                    <li key={sid}>
                      <fieldset className="grid gap-3 rounded-[var(--radius-control)] border border-border p-3 sm:grid-cols-4">
                        <legend className="px-1 font-semibold">
                          {nameOf(sid)}
                          {r ? <span className="ml-2 text-sm font-normal text-muted">{fmt(s.source, { source: s.sources[r.source as 'teacher'] })}</span> : null}
                        </legend>
                        <input type="hidden" name="studentIds" value={sid} />
                        <SelectField name={`status_${sid}`} label={s.markStatus} defaultValue={r?.status ?? ''} idPrefix={`m-${sid}`}>
                          <option value="">{s.notMarked}</option>
                          {ATTENDANCE_STATUSES.map((st) => (
                            <option key={st} value={st}>
                              {s.attendance[st]}
                            </option>
                          ))}
                        </SelectField>
                        <Field name={`late_${sid}`} label={s.minutesLate} type="number" min={1} max={480} defaultValue={r?.minutes_late ?? ''} idPrefix={`m-${sid}`} />
                        <SelectField name={`reason_${sid}`} label={s.absenceReason} defaultValue={r?.absence_reason ?? ''} idPrefix={`m-${sid}`}>
                          <option value="">{s.notMarked}</option>
                          {ABSENCE_REASONS.map((rs) => (
                            <option key={rs} value={rs}>
                              {s.reasons[rs]}
                            </option>
                          ))}
                        </SelectField>
                        <Field name={`note_${sid}`} label={s.comment} maxLength={500} defaultValue={r?.note ?? ''} idPrefix={`m-${sid}`} />
                      </fieldset>
                    </li>
                  );
                })}
              </ul>
              {staffCorrection ? <Field name="reason" label={s.correctionReason} hint={s.correctionHint} maxLength={500} idPrefix="m" /> : null}
            </ActionForm>
          ) : null}

          {canMark && win.running ? (
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{s.codeTitle}</h3>
              <p className="text-sm text-muted">{s.codeHint}</p>
              <ActionForm action={openCodeAction} submitLabel={s.openCode} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="sessionId" value={id} />
              </ActionForm>
            </div>
          ) : null}

          {pendingCamera.length ? (
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{s.cameraTitle}</h3>
              <p className="text-sm text-muted">{s.cameraHint}</p>
              <ul className="space-y-2">
                {pendingCamera.map((e) => (
                  <li key={e.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
                    <span>
                      {e.student_id ? nameOf(e.student_id as string) : s.unknownPerson} · {formatTime(locale, e.occurred_at as string, tz)}
                      {e.confidence !== null ? ` · ${fmt(s.confidence, { value: String(e.confidence) })}` : ''}
                    </span>
                    {canMark && e.student_id ? (
                      <ActionForm action={confirmCameraEventAction} submitLabel={s.confirm} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="eventId" value={e.id as string} />
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {(history.data ?? []).length ? (
        <section aria-labelledby="hist-h" className="space-y-3">
          <h2 id="hist-h" className="text-xl font-bold">
            {s.historyTitle}
          </h2>
          <ul className="space-y-1 text-sm">
            {(history.data ?? []).map((h) => (
              <li key={String(h.id)}>
                {formatShortDateTime(locale, h.changed_at as string, tz)} · {nameOf(h.student_id as string)}: {s.attendance[h.status as 'present']}
                {h.minutes_late ? ` (${h.minutes_late as number})` : ''} · {fmt(s.source, { source: s.sources[h.source as 'teacher'] })}
                {h.changed_by ? ` · ${s.by}: ${nameOf(h.changed_by as string)}` : ''}
                {h.reason ? ` · ${s.reason}: ${h.reason as string}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canSchedule && status === 'scheduled' ? (
        <section aria-labelledby="edit-h" className="space-y-3">
          <h2 id="edit-h" className="text-xl font-bold">
            {s.editTitle}
          </h2>
          <p className="text-sm text-muted">{s.editHint}</p>
          <ActionForm
            action={rescheduleAction}
            submitLabel={s.saveChanges}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ date: s.date, startTime: s.startTime, minutes: s.minutes, classroomId: s.classroom, onlineUrl: s.onlineUrl, note: s.note }}
            className="grid gap-4 sm:grid-cols-2"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionId" value={id} />
            <Field name="date" label={s.date} type="date" required defaultValue={localDate(startIso, tz)} idPrefix="rs" />
            <Field name="startTime" label={s.startTime} type="time" required defaultValue={localTime} idPrefix="rs" />
            <Field name="minutes" label={s.minutes} type="number" min={15} max={480} step={5} required defaultValue={minutes} idPrefix="rs" />
            <SelectField name="classroomId" label={s.classroom} defaultValue={(row.classroom_id as string | null) ?? ''} idPrefix="rs">
              <option value="">{s.noClassroom}</option>
              {(rooms.data ?? []).map((r) => (
                <option key={r.id as string} value={r.id as string}>
                  {r.name as string}
                </option>
              ))}
            </SelectField>
            <Field name="onlineUrl" label={s.onlineUrl} type="url" maxLength={500} defaultValue={(row.online_url as string | null) ?? ''} idPrefix="rs" />
            <Field name="note" label={s.note} maxLength={500} idPrefix="rs" />
          </ActionForm>

          <h2 className="text-xl font-bold">{s.cancelTitle}</h2>
          <ActionForm
            action={cancelSessionAction}
            submitLabel={s.cancel}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ reason: s.cancelReason }}
            variant="danger"
            confirm={{ title: s.cancelConfirmTitle, text: s.cancelConfirmText, confirmLabel: s.cancel, cancelLabel: s.keep }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionId" value={id} />
            <Field name="reason" label={s.cancelReason} required minLength={3} maxLength={500} idPrefix="cs" />
          </ActionForm>
        </section>
      ) : null}

      <section aria-labelledby="chg-h" className="space-y-3">
        <h2 id="chg-h" className="text-xl font-bold">
          {s.changesTitle}
        </h2>
        {(changes.data ?? []).length === 0 ? (
          <p className="text-muted">{s.noChanges}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(changes.data ?? []).map((c) => (
              <li key={c.id as string}>
                {formatShortDateTime(locale, c.created_at as string, tz)} · {(c.kinds as string[]).map((k) => s.changeKinds[k as 'rescheduled']).join(', ')}
                {c.note ? ` · ${c.note as string}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </WorkspacePage>
  );
}

