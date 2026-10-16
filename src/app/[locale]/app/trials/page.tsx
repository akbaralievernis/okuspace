import { notFound } from 'next/navigation';
import { AppHeader, appNav } from '@/components/app-header';
import { SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { formatDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { cancelTrialSlotAction, createTrialSlotAction } from '@/server/site-admin/actions';
import { createUserClient } from '@/server/supabase/server';

type Slot = { id: string; branch_id: string; organization_id: string; period: string; format: 'online' | 'offline'; capacity: number; status: 'open' | 'closed' | 'cancelled' };

/** Начало интервала tstzrange из PostgREST: '["2026-10-20 04:00:00+00","2026-10-20 05:00:00+00")'. */
function rangeStart(period: string): string {
  const raw = period.slice(1).split(',')[0]!.replaceAll('"', '');
  return new Date(raw.replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString();
}

export default async function TrialsAdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/trials`);
  const t = getDictionary(locale);
  const a = t.admin.trials;
  const messages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const m = ctx.memberships;

  const client = await createUserClient();
  const orgIds = [...new Set(m.map((x) => x.organizationId))];
  const [branchesRes, coursesRes, slotsRes] = await Promise.all([
    client.from('branches').select('id, organization_id, name, city, timezone').in('organization_id', orgIds).eq('status', 'active').order('name'),
    client.from('courses').select('id, organization_id, title').in('organization_id', orgIds).eq('status', 'published').order('title'),
    client.from('trial_slots').select('id, organization_id, branch_id, period, format, capacity, status').in('organization_id', orgIds).order('period', { ascending: false }).limit(100),
  ]);
  const branches = (branchesRes.data ?? []).filter((b) => can(m, 'schedule.manage', b.organization_id as string, b.id as string));
  const branchById = new Map((branchesRes.data ?? []).map((b) => [b.id as string, b]));
  const slots = ((slotsRes.data ?? []) as Slot[]).filter((s) => can(m, 'schedule.manage', s.organization_id, s.branch_id));

  if (branches.length === 0) {
    return (
      <>
        <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
        <main id="main" className="container-page py-8">
          <PageHeader title={a.title} />
          <p>{t.admin.common.noRights}</p>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="container-page space-y-10 py-8">
        <PageHeader title={a.title} />
        {branchesRes.error || slotsRes.error ? <Notice tone="warning">{t.auth.errors.unavailable}</Notice> : null}

        <section aria-labelledby="create-h" className="max-w-xl space-y-4">
          <h2 id="create-h" className="text-xl font-bold">
            {a.create}
          </h2>
          {branches.map((b) => (
            <details key={b.id as string} className="rounded-[var(--radius-card)] border border-border p-4">
              <summary className="cursor-pointer font-medium">
                {b.city as string} — {b.name as string}
              </summary>
              <ActionForm
                action={createTrialSlotAction}
                submitLabel={a.create}
                pendingLabel={t.common.pending}
                messages={messages}
                fieldLabels={{ start: a.start, durationMinutes: a.duration, capacity: a.capacity }}
                className="mt-4 space-y-4"
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="organizationId" value={b.organization_id as string} />
                <input type="hidden" name="branchId" value={b.id as string} />
                <Field name="start" idPrefix={`slot-${b.id as string}`} type="datetime-local" label={`${a.start} (${b.timezone as string})`} required />
                <Field name="durationMinutes" idPrefix={`slot-${b.id as string}`} type="number" label={a.duration} defaultValue={60} min={15} max={180} required />
                <Field name="capacity" idPrefix={`slot-${b.id as string}`} type="number" label={a.capacity} defaultValue={5} min={1} max={50} required />
                <SelectField name="format" idPrefix={`slot-${b.id as string}`} label={a.format}>
                  <option value="offline">{t.site.formats.offline}</option>
                  <option value="online">{t.site.formats.online}</option>
                </SelectField>
                <SelectField name="courseId" idPrefix={`slot-${b.id as string}`} label={a.course}>
                  <option value="">{a.noCourse}</option>
                  {(coursesRes.data ?? [])
                    .filter((c) => c.organization_id === b.organization_id)
                    .map((c) => (
                      <option key={c.id as string} value={c.id as string}>
                        {c.title as string}
                      </option>
                    ))}
                </SelectField>
              </ActionForm>
            </details>
          ))}
        </section>

        <section aria-labelledby="slots-h" className="space-y-3">
          <h2 id="slots-h" className="text-xl font-bold">
            {a.title}
          </h2>
          {slots.length === 0 ? (
            <EmptyState title={a.empty} />
          ) : (
            <ul className="space-y-2">
              {slots.map((s) => {
                const b = branchById.get(s.branch_id);
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border px-4 py-3">
                    <span>
                      {formatDateTime(locale, rangeStart(s.period), (b?.timezone as string) ?? 'Asia/Bishkek')} · {(b?.name as string) ?? '—'} ·{' '}
                      {t.site.formats[s.format]} · {fmt(t.site.trial.spots, { count: s.capacity })}{' '}
                      <Badge tone={s.status === 'open' ? 'success' : 'neutral'}>{a.statuses[s.status]}</Badge>
                    </span>
                    {s.status === 'open' ? (
                      <ActionForm
                        action={cancelTrialSlotAction}
                        submitLabel={a.cancel}
                        pendingLabel={t.common.pending}
                        messages={messages}
                        variant="danger"
                        className="flex items-center gap-2"
                        confirm={{ title: a.cancelTitle, text: a.cancelText, confirmLabel: a.cancel, cancelLabel: t.admin.common.cancel }}
                      >
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="id" value={s.id} />
                      </ActionForm>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
