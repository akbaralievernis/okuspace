import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatDate, formatDayHeading, formatTime, weekdayName } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { checkInAction, createSeriesAction } from '@/server/schedule/actions';
import { scheduleWindow, type SessionItem } from '@/server/schedule/queries';
import { addDays, localDate, weekStart } from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

type Search = { week?: string; branch?: string; teacher?: string; group?: string; room?: string };
const UUID = /^[0-9a-f-]{36}$/i;
const pick = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);

export default async function SchedulePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/schedule`);
  const t = getDictionary(locale);
  const s = t.schedule;
  const msg = authMessages(t);
  const sp = await searchParams;
  const filters = { branch: pick(sp.branch), teacher: pick(sp.teacher), group: pick(sp.group), room: pick(sp.room) };

  const today = localDate(new Date(), DEFAULT_TIMEZONE);
  const monday = weekStart(sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  // Окно с запасом в сутки: локальные даты филиалов в разных поясах.
  const all = await scheduleWindow(new Date(`${addDays(monday, -1)}T00:00:00Z`), new Date(`${addDays(monday, 8)}T00:00:00Z`));
  const sessions = (all ?? []).filter(
    (x) =>
      days.includes(localDate(x.start, x.timezone)) &&
      (!filters.branch || x.branchId === filters.branch) &&
      (!filters.teacher || x.teacherId === filters.teacher) &&
      (!filters.group || x.groupId === filters.group) &&
      (!filters.room || x.classroomId === filters.room),
  );

  const m = ctx.memberships;
  const schedulerBranches = m.filter((x) => x.status === 'active' && can(m, 'schedule.manage', x.organizationId, x.branchId));
  const isScheduler = schedulerBranches.length > 0;
  const isStudent = m.some((x) => x.role === 'student' && x.status === 'active');
  const staffView = isScheduler || m.some((x) => x.status === 'active' && can(m, 'group.read', x.organizationId, x.branchId));

  // Справочники для фильтров и формы — то, что видно по RLS.
  const db = await createUserClient();
  const [groups, rooms, groupTeachers] = staffView
    ? await Promise.all([
        db.from('groups').select('id, name, branch_id, organization_id, status').neq('status', 'cancelled').order('name'),
        db.from('classrooms').select('id, name, branch_id, status').eq('status', 'active').order('name'),
        db.from('group_teachers').select('group_id, teacher_id'),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const teacherIds = [...new Set([...(groupTeachers.data ?? []).map((x) => x.teacher_id as string), ...(all ?? []).map((x) => x.teacherId)])];
  const { data: people } = teacherIds.length ? await db.from('profiles').select('id, full_name').in('id', teacherIds) : { data: [] };
  const nameOf = (id: string) => ((people ?? []).find((p) => p.id === id)?.full_name as string) || '—';
  const branches = [...new Map((all ?? []).map((x) => [x.branchId, x.branchName])).entries()];
  const schedulerGroups = (groups.data ?? []).filter((g) => can(m, 'schedule.manage', g.organization_id as string, g.branch_id as string));
  const groupName = (id: string) => ((groups.data ?? []).find((g) => g.id === id)?.name as string) ?? '';

  const weekHref = (week: string) => {
    const q = new URLSearchParams({ week });
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    return `/${locale}/app/schedule?${q.toString()}`;
  };

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={s.title} unavailable={all === null}>
      {m.some((x) => x.status === 'active' && (can(m, 'schedule.manage', x.organizationId, x.branchId) || can(m, 'attendance.manage', x.organizationId, x.branchId))) ? (
        <p>
          <Link className="link" href={`/${locale}/app/schedule/makeups`}>
            {t.auto.makeups.link}
          </Link>
        </p>
      ) : null}
      <nav aria-label={s.title} className="flex flex-wrap items-center gap-4">
        <Link className="link" href={weekHref(addDays(monday, -7))}>
          {s.prevWeek}
        </Link>
        <Link className="link" href={weekHref(weekStart(today))}>
          {s.thisWeek}
        </Link>
        <Link className="link" href={weekHref(addDays(monday, 7))}>
          {s.nextWeek}
        </Link>
        {isScheduler ? (
          <Link className="link" href={`/${locale}/app/schedule/rooms`}>
            {s.rooms}
          </Link>
        ) : null}
      </nav>
      <h2 className="text-xl font-semibold">{fmt(s.weekOf, { from: formatDate(locale, days[0]!), to: formatDate(locale, days[6]!) })}</h2>

      {staffView ? (
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s.filters}>
          <input type="hidden" name="week" value={monday} />
          <SelectField name="branch" label={s.branch} defaultValue={filters.branch ?? ''} idPrefix="f">
            <option value="">{s.all}</option>
            {branches.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </SelectField>
          <SelectField name="group" label={s.group} defaultValue={filters.group ?? ''} idPrefix="f">
            <option value="">{s.all}</option>
            {(groups.data ?? []).map((g) => (
              <option key={g.id as string} value={g.id as string}>
                {g.name as string}
              </option>
            ))}
          </SelectField>
          <SelectField name="teacher" label={s.teacher} defaultValue={filters.teacher ?? ''} idPrefix="f">
            <option value="">{s.all}</option>
            {teacherIds.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </SelectField>
          <SelectField name="room" label={s.classroom} defaultValue={filters.room ?? ''} idPrefix="f">
            <option value="">{s.all}</option>
            {(rooms.data ?? []).map((r) => (
              <option key={r.id as string} value={r.id as string}>
                {r.name as string}
              </option>
            ))}
          </SelectField>
          <button type="submit" className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-4 hover:bg-surface-muted">
            {s.show}
          </button>
        </form>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState title={s.empty} />
      ) : (
        <div className="space-y-6">
          {days.map((day) => {
            const list = sessions.filter((x) => localDate(x.start, x.timezone) === day);
            if (list.length === 0) return null;
            return (
              <section key={day} aria-labelledby={`d-${day}`} className="space-y-2">
                <h3 id={`d-${day}`} className="text-lg font-semibold first-letter:uppercase">
                  {formatDayHeading(locale, day)}
                </h3>
                <ul className="space-y-2">
                  {list.map((x) => (
                    <SessionRow key={x.id} x={x} locale={locale} t={t} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {isStudent ? (
        <section aria-labelledby="checkin-h" className="space-y-3">
          <h2 id="checkin-h" className="text-xl font-bold">
            {s.checkInTitle}
          </h2>
          <ActionForm action={checkInAction} submitLabel={s.checkIn} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ code: s.code }} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="locale" value={locale} />
            <Field name="code" label={s.code} hint={s.checkInHint} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required idPrefix="ci" />
          </ActionForm>
        </section>
      ) : null}

      {isScheduler && schedulerGroups.length ? (
        <section aria-labelledby="add-h" className="space-y-3">
          <h2 id="add-h" className="text-xl font-bold">
            {s.addTitle}
          </h2>
          <p className="text-sm text-muted">{s.addHint}</p>
          <ActionForm
            action={createSeriesAction}
            submitLabel={s.create}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ groupId: s.group, teacherId: s.teacher, classroomId: s.classroom, onlineUrl: s.onlineUrl, firstDate: s.firstDate, weekdays: s.weekdays, startTime: s.startTime, minutes: s.minutes, count: s.count, topic: s.topic }}
            className="grid gap-4 sm:grid-cols-2"
          >
            <input type="hidden" name="locale" value={locale} />
            <SelectField name="groupId" label={s.group} required idPrefix="ns">
              {schedulerGroups.map((g) => (
                <option key={g.id as string} value={g.id as string}>
                  {g.name as string}
                </option>
              ))}
            </SelectField>
            <SelectField name="teacherId" label={s.teacher} required idPrefix="ns">
              {(groupTeachers.data ?? [])
                .filter((gt) => schedulerGroups.some((g) => g.id === gt.group_id))
                .map((gt) => (
                  <option key={`${gt.group_id as string}-${gt.teacher_id as string}`} value={gt.teacher_id as string}>
                    {nameOf(gt.teacher_id as string)} — {groupName(gt.group_id as string)}
                  </option>
                ))}
            </SelectField>
            <SelectField name="classroomId" label={s.classroom} idPrefix="ns">
              <option value="">{s.noClassroom}</option>
              {(rooms.data ?? [])
                .filter((r) => schedulerBranches.some((b) => b.branchId === null || b.branchId === r.branch_id))
                .map((r) => (
                  <option key={r.id as string} value={r.id as string}>
                    {r.name as string}
                  </option>
                ))}
            </SelectField>
            <Field name="onlineUrl" label={s.onlineUrl} type="url" inputMode="url" maxLength={500} idPrefix="ns" />
            <Field name="firstDate" label={s.firstDate} type="date" required defaultValue={today} idPrefix="ns" />
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{s.weekdays}</legend>
              <div className="flex flex-wrap gap-3">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <label key={d} className="inline-flex min-h-11 items-center gap-2">
                    <input type="checkbox" name="weekdays" value={d} className="size-5 accent-brand-700" />
                    {weekdayName(locale, d)}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field name="startTime" label={s.startTime} type="time" required idPrefix="ns" />
            <Field name="minutes" label={s.minutes} type="number" min={15} max={480} step={5} defaultValue={90} required idPrefix="ns" />
            <Field name="count" label={s.count} type="number" min={1} max={200} defaultValue={1} required idPrefix="ns" />
            <Field name="topic" label={s.topic} maxLength={200} idPrefix="ns" />
          </ActionForm>
        </section>
      ) : null}
    </WorkspacePage>
  );
}

function SessionRow({ x, locale, t }: { x: SessionItem; locale: Parameters<typeof formatTime>[0]; t: ReturnType<typeof getDictionary> }) {
  const s = t.schedule;
  const cancelled = x.status === 'cancelled';
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2">
      <div className="space-y-1">
        <p className={cancelled ? 'text-muted line-through' : 'font-semibold'}>
          {formatTime(locale, x.start, x.timezone)}–{formatTime(locale, x.end, x.timezone)} · {x.groupName}
        </p>
        <p className="text-sm text-muted">
          {x.teacherName ?? '—'} · {x.classroomName ?? s.online} · {x.branchName}
          {x.topic ? ` · ${x.topic}` : ''}
        </p>
        {x.marks.length ? (
          <p className="text-sm">
            {x.marks
              .map((mk) => fmt(s.childMark, { name: mk.studentName ?? '—', status: s.attendance[mk.status as 'present'] ?? mk.status }))
              .join(' · ')}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={cancelled ? 'warning' : x.status === 'done' ? 'success' : 'neutral'}>{s.statuses[x.status]}</Badge>
        {x.onlineUrl && !cancelled ? (
          <a className="link" href={x.onlineUrl} target="_blank" rel="noopener noreferrer">
            {s.join}
          </a>
        ) : null}
        <Link className="link" href={`/${locale}/app/schedule/sessions/${x.id}`}>
          {s.open}
        </Link>
      </div>
    </li>
  );
}
