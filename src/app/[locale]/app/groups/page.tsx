import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { createGroupAction } from '@/server/lms/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function GroupsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/groups`);
  const t = getDictionary(locale);
  const g = t.lms.groups;
  const m = ctx.memberships;
  const orgIds = [...new Set(m.map((x) => x.organizationId))];

  const db = await createUserClient();
  // RLS отдаёт только группы, которые пользователь вправе видеть.
  const [groups, branches, courses, enrollments] = await Promise.all([
    db.from('groups').select('id, organization_id, branch_id, course_id, name, capacity, starts_on, status, enrollment_status, schedule_note').order('starts_on', { ascending: false }),
    db.from('branches').select('id, organization_id, name, city').in('organization_id', orgIds).eq('status', 'active'),
    db.from('courses').select('id, organization_id, title, status').in('organization_id', orgIds).neq('status', 'archived').order('title'),
    db.from('enrollments').select('group_id, status').in('status', ['pending', 'active']),
  ]);
  const branchName = new Map((branches.data ?? []).map((b) => [b.id as string, `${b.city as string} — ${b.name as string}`]));
  const courseTitle = new Map((courses.data ?? []).map((c) => [c.id as string, c.title as string]));
  const taken = (gid: string) => (enrollments.data ?? []).filter((e) => e.group_id === gid).length;
  const manageable = (branches.data ?? []).filter((b) => can(m, 'group.manage', b.organization_id as string, b.id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={g.title} unavailable={!!groups.error}>
      {(groups.data ?? []).length === 0 ? (
        <EmptyState title={g.empty} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {(groups.data ?? []).map((grp) => (
            <li key={grp.id as string} className="relative space-y-1 rounded-[var(--radius-card)] border border-border p-4">
              <p className="font-semibold">
                <Link href={`/${locale}/app/groups/${grp.id as string}`} className="text-ink no-underline after:absolute after:inset-0 hover:underline">
                  {grp.name as string}
                </Link>{' '}
                <Badge>{g.groupStatuses[grp.status as 'planned']}</Badge>
              </p>
              <p className="text-sm text-muted">
                {courseTitle.get(grp.course_id as string) ?? '—'} · {branchName.get(grp.branch_id as string) ?? '—'}
              </p>
              <p className="text-sm text-muted">
                {formatDate(locale, grp.starts_on as string)} · {fmt(g.seats, { taken: taken(grp.id as string), capacity: grp.capacity as number })} ·{' '}
                {g.enrollmentStatuses[grp.enrollment_status as 'open']}
              </p>
              {grp.schedule_note ? <p className="text-sm">{grp.schedule_note as string}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {manageable.length > 0 && (courses.data ?? []).length > 0 ? (
        <details className="max-w-2xl rounded-[var(--radius-card)] border border-border p-4">
          <summary className="cursor-pointer font-medium">{g.newGroup}</summary>
          <ActionForm
            action={createGroupAction}
            submitLabel={t.lms.common.create}
            pendingLabel={t.common.pending}
            messages={authMessages(t)}
            fieldLabels={{ name: g.name, capacity: g.capacity, startsOn: g.startsOn, endsOn: g.endsOn }}
            className="mt-4 grid gap-4 sm:grid-cols-2"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={manageable[0]!.organization_id as string} />
            <SelectField name="branchId" label={g.branch} idPrefix="grp">
              {manageable.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {branchName.get(b.id as string)}
                </option>
              ))}
            </SelectField>
            <SelectField name="courseId" label={g.course} idPrefix="grp">
              {(courses.data ?? [])
                .filter((c) => c.organization_id === manageable[0]!.organization_id)
                .map((c) => (
                  <option key={c.id as string} value={c.id as string}>
                    {c.title as string}
                  </option>
                ))}
            </SelectField>
            <Field name="name" label={g.name} required idPrefix="grp" />
            <Field name="capacity" type="number" min={1} max={500} defaultValue={10} label={g.capacity} idPrefix="grp" />
            <Field name="startsOn" type="date" label={g.startsOn} required idPrefix="grp" />
            <Field name="endsOn" type="date" label={g.endsOn} idPrefix="grp" />
            <Field name="scheduleNote" label={g.scheduleNote} maxLength={200} idPrefix="grp" />
            <SelectField name="enrollmentStatus" label={g.enrollment} idPrefix="grp">
              {(['open', 'waitlist', 'closed'] as const).map((s) => (
                <option key={s} value={s}>
                  {g.enrollmentStatuses[s]}
                </option>
              ))}
            </SelectField>
          </ActionForm>
        </details>
      ) : null}
    </WorkspacePage>
  );
}
