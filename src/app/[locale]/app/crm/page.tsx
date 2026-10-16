import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { createContactAction } from '@/server/crm/actions';
import { SOURCES, STAGES } from '@/server/crm/constants';
import { createUserClient } from '@/server/supabase/server';

type Search = { stage?: string; owner?: string; q?: string };

/** Поиск для PostgREST .or(): убираем символы синтаксиса фильтра. */
const safeQuery = (q: string) => q.replace(/[,()*%\\:"']/g, ' ').trim().slice(0, 60);

export default async function CrmPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/crm`);
  const t = getDictionary(locale);
  const c = t.crm;
  const sp = await searchParams;
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const readable = m.filter((x) => can(m, 'lead.read', x.organizationId, x.branchId));
  const orgs = [...new Set(readable.map((x) => x.organizationId))];
  const isAdmin = m.some((x) => can(m, 'crm.admin', x.organizationId, x.branchId));
  const canManage = m.some((x) => can(m, 'lead.manage', x.organizationId, x.branchId));
  const db = await createUserClient();

  let query = db.from('crm_contacts').select('id, organization_id, full_name, phone, email, stage, source, owner_id, last_activity_at').is('erased_at', null);
  if (sp.stage && (STAGES as readonly string[]).includes(sp.stage)) query = query.eq('stage', sp.stage);
  if (sp.owner === 'mine') query = query.eq('owner_id', ctx.user.id);
  if (sp.owner === 'none') query = query.is('owner_id', null);
  const q = safeQuery(sp.q ?? '');
  if (q) {
    const digits = q.replace(/\D/g, '');
    query = query.or([`full_name.ilike.*${q}*`, `email.ilike.*${q.toLowerCase()}*`, ...(digits.length >= 3 ? [`phone.ilike.*${digits}*`] : [])].join(','));
  }
  const now = new Date();
  const [{ data: contacts }, { data: reminders }, funnels, { data: branches }] = await Promise.all([
    orgs.length ? query.order('last_activity_at', { ascending: false }).limit(100) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    db.from('crm_reminders').select('id, contact_id, due_at, note, crm_contacts(full_name)').eq('assignee_id', ctx.user.id).eq('status', 'open').order('due_at').limit(20),
    Promise.all(orgs.map(async (org) => (await db.rpc('crm_funnel', { p_org: org, p_from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), p_to: now.toISOString() })).data as Funnel | null)),
    orgs.length ? db.from('branches').select('id, organization_id, name').in('organization_id', orgs).order('name') : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const ownerIds = [...new Set((contacts ?? []).map((x) => x.owner_id as string | null).filter((x): x is string => Boolean(x)))];
  const { data: owners } = ownerIds.length ? await db.from('profiles').select('id, full_name').in('id', ownerIds) : { data: [] };
  const nameOf = (id: string | null) => (id ? ((owners ?? []).find((p) => p.id === id)?.full_name as string) || '—' : c.unassigned);
  const manageBranches = (branches ?? []).filter((b) => can(m, 'lead.manage', b.organization_id as string, b.id as string));
  const orgLevel = orgs.filter((org) => can(m, 'lead.manage', org, null));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={c.title} allowed={orgs.length > 0}>
      <p className="flex flex-wrap gap-4">
        <Link className="link" href={`/${locale}/app/requests`}>
          {c.requestsLink}
        </Link>
        {canManage ? (
          <Link className="link" href={`/${locale}/app/crm/import`}>
            {c.importLink}
          </Link>
        ) : null}
        {isAdmin
          ? orgs.map((org) => (
              <a key={org} className="link" href={`/${locale}/app/crm/export?org=${org}`} download>
                {c.exportLink}
              </a>
            ))
          : null}
      </p>
      {isAdmin ? <p className="text-sm text-muted">{c.exportHint}</p> : null}

      {funnels.filter(Boolean).map((f, i) => (
        <section key={i} aria-labelledby={`funnel-${i}`} className="space-y-3">
          <h2 id={`funnel-${i}`} className="text-xl font-bold">
            {c.funnelTitle}
          </h2>
          <p>
            {fmt(c.total, { count: f!.total })} · {fmt(c.conversion, { won: f!.won, rate: f!.total ? Math.round((100 * f!.won) / f!.total) : 0 })}
          </p>
          <ul className="flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <li key={s}>
                <Badge tone={s === 'won' ? 'success' : s === 'lost' ? 'warning' : 'neutral'}>
                  {c.stages[s]}: {f!.byStage[s] ?? 0}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            {c.bySource}:{' '}
            {Object.entries(f!.bySource)
              .map(([src, v]) => fmt(c.sourceLine, { source: c.sources[src as 'phone'] ?? src, total: v.total, won: v.won }))
              .join('; ') || '—'}
          </p>
        </section>
      ))}

      <section aria-labelledby="rem-h" className="space-y-2">
        <h2 id="rem-h" className="text-xl font-bold">
          {c.remindersTitle}
        </h2>
        {(reminders ?? []).length === 0 ? <p className="text-muted">{c.noReminders}</p> : null}
        <ul className="space-y-1">
          {(reminders ?? []).map((r) => {
            const contact = r.crm_contacts as unknown as { full_name: string } | { full_name: string }[] | null;
            const name = (Array.isArray(contact) ? contact[0]?.full_name : contact?.full_name) ?? '—';
            const overdue = Date.parse(r.due_at as string) < now.getTime();
            return (
              <li key={r.id as string} className="flex flex-wrap items-center gap-2">
                {overdue ? <Badge tone="warning">{c.overdue}</Badge> : null}
                <span>{fmt(c.due, { date: formatShortDateTime(locale, r.due_at as string, DEFAULT_TIMEZONE) })}</span>
                <Link className="link" href={`/${locale}/app/crm/contacts/${r.contact_id as string}`}>
                  {name}
                </Link>
                {r.note ? <span className="text-sm text-muted">— {r.note as string}</span> : null}
              </li>
            );
          })}
        </ul>
      </section>

      <form method="get" className="flex flex-wrap items-end gap-3" aria-label={c.search}>
        <SelectField name="stage" label={c.stage} defaultValue={sp.stage ?? ''} idPrefix="f">
          <option value="">{c.all}</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {c.stages[s]}
            </option>
          ))}
        </SelectField>
        <SelectField name="owner" label={c.owner} defaultValue={sp.owner ?? ''} idPrefix="f">
          <option value="">{c.all}</option>
          <option value="mine">{c.ownerMine}</option>
          <option value="none">{c.ownerNone}</option>
        </SelectField>
        <Field name="q" label={c.search} defaultValue={sp.q ?? ''} maxLength={60} idPrefix="f" />
        <button type="submit" className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-4 hover:bg-surface-muted">
          {c.show}
        </button>
      </form>

      {(contacts ?? []).length === 0 ? (
        <EmptyState title={c.empty} />
      ) : (
        <ul className="space-y-2">
          {(contacts ?? []).map((x) => (
            <li key={x.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <span className="space-y-1">
                <Link className="link font-semibold" href={`/${locale}/app/crm/contacts/${x.id as string}`}>
                  {x.full_name as string}
                </Link>
                <span className="block text-sm text-muted">
                  {[x.phone, x.email].filter(Boolean).join(' · ')} · {c.sources[x.source as 'phone']} · {nameOf(x.owner_id as string | null)} ·{' '}
                  {fmt(c.lastActivity, { date: formatShortDateTime(locale, x.last_activity_at as string, DEFAULT_TIMEZONE) })}
                </span>
              </span>
              <Badge tone={x.stage === 'won' ? 'success' : x.stage === 'lost' ? 'warning' : 'neutral'}>{c.stages[x.stage as 'new']}</Badge>
            </li>
          ))}
        </ul>
      )}

      {manageBranches.length || orgLevel.length ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{c.newContact}</h2>
          <ActionForm
            action={createContactAction}
            submitLabel={c.create}
            pendingLabel={t.common.pending}
            messages={authMessages(t)}
            fieldLabels={{ fullName: c.fullName, phone: c.phone, email: c.email, note: c.note }}
            className="grid gap-4 sm:grid-cols-2"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={orgs[0]!} />
            <Field name="fullName" label={c.fullName} required maxLength={120} idPrefix="nc" />
            <SelectField name="source" label={c.source} idPrefix="nc">
              {SOURCES.filter((s) => !s.startsWith('website') && s !== 'import').map((s) => (
                <option key={s} value={s}>
                  {c.sources[s]}
                </option>
              ))}
            </SelectField>
            <Field name="phone" label={c.phone} type="tel" autoComplete="off" maxLength={20} idPrefix="nc" />
            <Field name="email" label={c.email} type="email" autoComplete="off" maxLength={254} idPrefix="nc" />
            <SelectField name="branchId" label={c.branch} idPrefix="nc">
              {manageBranches.map((b) => (
                <option key={b.id as string} value={b.id as string}>
                  {b.name as string}
                </option>
              ))}
              {orgLevel.length ? <option value="">{c.noBranch}</option> : null}
            </SelectField>
            <TextareaField name="note" label={c.note} maxLength={2000} rows={2} idPrefix="nc" />
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}

type Funnel = { total: number; won: number; byStage: Record<string, number>; bySource: Record<string, { total: number; won: number }> };
