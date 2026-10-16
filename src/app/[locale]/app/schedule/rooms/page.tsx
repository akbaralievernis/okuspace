import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { saveClassroomAction, setClassroomStatusAction } from '@/server/schedule/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function RoomsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/schedule/rooms`);
  const t = getDictionary(locale);
  const s = t.schedule;
  const msg = authMessages(t);
  const m = ctx.memberships;
  const db = await createUserClient();
  const [{ data: branches }, { data: rooms }] = await Promise.all([
    db.from('branches').select('id, organization_id, name').order('name'),
    db.from('classrooms').select('id, organization_id, branch_id, name, capacity, status').order('name'),
  ]);
  // Управлять можно аудиториями филиалов, где есть schedule.manage.
  const manageable = (branches ?? []).filter((b) => can(m, 'schedule.manage', b.organization_id as string, b.id as string));
  const allowed = manageable.length > 0;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={s.roomsTitle} allowed={allowed}>
      <p>
        <Link className="link" href={`/${locale}/app/schedule`}>
          {s.title}
        </Link>
      </p>
      {manageable.map((b) => {
        const list = (rooms ?? []).filter((r) => r.branch_id === b.id);
        return (
          <section key={b.id as string} aria-labelledby={`b-${b.id as string}`} className="space-y-3">
            <h2 id={`b-${b.id as string}`} className="text-xl font-bold">
              {b.name as string}
            </h2>
            {list.length === 0 ? <EmptyState title={s.noRooms} /> : null}
            <ul className="space-y-2">
              {list.map((r) => {
                const archived = r.status === 'archived';
                return (
                  <li key={r.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
                    <span>
                      {r.name as string} · {s.capacity}: {r.capacity as number} {archived ? <Badge tone="warning">{s.archived}</Badge> : null}
                    </span>
                    <ActionForm action={setClassroomStatusAction} submitLabel={archived ? s.restore : s.archive} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="classroomId" value={r.id as string} />
                      <input type="hidden" name="status" value={archived ? 'active' : 'archived'} />
                    </ActionForm>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {allowed ? (
        <section aria-labelledby="room-add-h" className="space-y-3">
          <h2 id="room-add-h" className="text-xl font-bold">
            {s.addRoom}
          </h2>
          <ActionForm action={saveClassroomAction} submitLabel={s.addRoom} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ name: s.roomName, capacity: s.capacity }} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={(manageable[0]?.organization_id as string) ?? ''} />
            <SelectField name="branchId" label={s.branch} required idPrefix="room">
              {manageable.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
            </SelectField>
            <Field name="name" label={s.roomName} required maxLength={100} idPrefix="room" />
            <Field name="capacity" label={s.capacity} type="number" min={1} max={500} defaultValue={12} required idPrefix="room" />
          </ActionForm>
        </section>
      ) : null}
    </WorkspacePage>
  );
}
