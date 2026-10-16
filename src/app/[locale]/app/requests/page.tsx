import { notFound } from 'next/navigation';
import { AppHeader, appNav } from '@/components/app-header';
import { SelectField } from '@/components/ui/controls';
import { Badge, EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { setLeadStatusAction } from '@/server/site-admin/actions';
import { createUserClient } from '@/server/supabase/server';

const STATUSES = ['new', 'in_progress', 'done', 'spam'] as const;
type Status = (typeof STATUSES)[number];

export default async function RequestsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/requests`);
  const t = getDictionary(locale);
  const r = t.admin.requests;
  const messages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const canRead = ctx.memberships.some((m) => can(ctx.memberships, 'lead.read', m.organizationId, m.branchId));

  // RLS отдаёт только заявки в охвате пользователя.
  const client = await createUserClient();
  const { data, error } = canRead
    ? await client
        .from('lead_requests')
        .select('id, organization_id, branch_id, kind, full_name, phone, email, message, status, created_at, locale')
        .order('created_at', { ascending: false })
        .limit(100)
    : { data: [], error: null };
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="container-page space-y-6 py-8">
        <PageHeader title={r.title} />
        {!canRead ? (
          <p>{t.admin.common.noRights}</p>
        ) : error ? (
          <Notice tone="warning">{t.auth.errors.unavailable}</Notice>
        ) : (data ?? []).length === 0 ? (
          <EmptyState title={r.empty} />
        ) : (
          <ul className="space-y-3">
            {(data ?? []).map((lead) => {
              const manageable = can(ctx.memberships, 'lead.manage', lead.organization_id as string, (lead.branch_id as string | null) ?? null);
              const status = lead.status as Status;
              return (
                <li key={lead.id as string} className="space-y-2 rounded-[var(--radius-card)] border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brand">{r.kinds[lead.kind as 'trial' | 'contact']}</Badge>
                    <Badge tone={status === 'new' ? 'warning' : 'neutral'}>{r.statuses[status]}</Badge>
                    <span className="text-sm text-muted">
                      {r.received}: {dateFmt.format(new Date(lead.created_at as string))}
                    </span>
                  </div>
                  <p className="font-semibold">{lead.full_name as string}</p>
                  <p className="text-sm">
                    {r.contact}: {[lead.phone, lead.email].filter(Boolean).join(' · ')}
                  </p>
                  {lead.message ? <p className="whitespace-pre-wrap text-sm text-muted">{lead.message as string}</p> : null}
                  {manageable ? (
                    <ActionForm action={setLeadStatusAction} submitLabel={t.admin.common.apply} pendingLabel={t.common.pending} messages={messages} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="id" value={lead.id as string} />
                      <div className="w-48">
                        <SelectField name="status" label={r.setStatus} defaultValue={status} idPrefix={`lead-${lead.id as string}`}>
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {r.statuses[s]}
                            </option>
                          ))}
                        </SelectField>
                      </div>
                    </ActionForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
