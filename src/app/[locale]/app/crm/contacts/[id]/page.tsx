import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Card, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import {
  addReminderAction,
  assignOwnerAction,
  bookTrialAction,
  completeReminderAction,
  convertAction,
  enrollAction,
  eraseContactAction,
  logCommunicationAction,
  setStageAction,
  trialResultAction,
  updateContactAction,
} from '@/server/crm/actions';
import { CHANNELS, SOURCES, STAGES } from '@/server/crm/constants';
import { parsePeriod } from '@/server/schedule/schemas';
import { createUserClient } from '@/server/supabase/server';

const SALES_ROLES = ['org_director', 'branch_manager', 'admin', 'sales_manager'];
const one = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));

export default async function ContactPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/crm/contacts/${id}`);
  const t = getDictionary(locale);
  const c = t.crm;
  const msg = authMessages(t);
  const db = await createUserClient();
  // RLS: контакт виден только сотрудникам продаж его филиала.
  const { data: contact } = await db.from('crm_contacts').select('*, branches(name, timezone)').eq('id', id).maybeSingle();
  if (!contact) notFound();
  const org = contact.organization_id as string;
  const branch = (contact.branch_id as string | null) ?? null;
  const tz = one(contact.branches as { timezone: string } | null)?.timezone ?? DEFAULT_TIMEZONE;
  const m = ctx.memberships;
  const erased = Boolean(contact.erased_at);
  const canManage = !erased && can(m, 'lead.manage', org, branch);
  const isAdmin = !erased && can(m, 'crm.admin', org, branch);

  const [events, reminders, bookings, requests, staff, students, groups, slots] = await Promise.all([
    db.from('crm_events').select('id, kind, channel, body, from_stage, to_stage, actor_id, created_at').eq('contact_id', id).order('id', { ascending: false }),
    db.from('crm_reminders').select('id, assignee_id, due_at, note, status').eq('contact_id', id).order('due_at'),
    db.from('crm_trial_bookings').select('id, status, trial_slots(period)').eq('contact_id', id).order('created_at'),
    db.from('lead_requests').select('id, kind, message, created_at').eq('contact_id', id).order('created_at'),
    db.from('memberships').select('profile_id, role, branch_id').eq('organization_id', org).eq('status', 'active').in('role', SALES_ROLES),
    db.from('memberships').select('profile_id, branch_id').eq('organization_id', org).eq('status', 'active').eq('role', 'student'),
    db.from('groups').select('id, name, branch_id, status').eq('organization_id', org).in('status', ['planned', 'active']).order('name'),
    db.from('trial_slots').select('id, branch_id, period, format').eq('organization_id', org).eq('status', 'open').order('period').limit(50),
  ]);
  const inBranch = (b: unknown) => branch === null || b === null || b === branch;
  const salesPeople = [...new Set((staff.data ?? []).filter((s) => inBranch(s.branch_id)).map((s) => s.profile_id as string))];
  const studentIds = [...new Set((students.data ?? []).filter((s) => branch === null || s.branch_id === branch).map((s) => s.profile_id as string))];
  const actorIds = (events.data ?? []).map((e) => e.actor_id as string | null).filter((x): x is string => Boolean(x));
  const ids = [...new Set([...salesPeople, ...studentIds.slice(0, 300), ...actorIds, ...((contact.owner_id as string | null) ? [contact.owner_id as string] : []), ...((contact.profile_id as string | null) ? [contact.profile_id as string] : [])])];
  const { data: names } = ids.length ? await db.from('profiles').select('id, full_name').in('id', ids) : { data: [] };
  const nameOf = (pid: string | null) => (pid ? ((names ?? []).find((p) => p.id === pid)?.full_name as string) || '—' : '—');
  const nowMs = Date.parse(new Date().toISOString());
  const futureSlots = (slots.data ?? []).filter((s) => inBranch(s.branch_id) && Date.parse(parsePeriod(s.period as string)[0]) > nowMs);
  const stage = contact.stage as (typeof STAGES)[number];

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={contact.full_name as string}>
      <p className="flex flex-wrap items-center gap-3">
        <Link className="link" href={`/${locale}/app/crm`}>
          {c.back}
        </Link>
        <Badge tone={stage === 'won' ? 'success' : stage === 'lost' ? 'warning' : 'neutral'}>{c.stages[stage]}</Badge>
        <span className="text-sm text-muted">
          {c.sources[contact.source as 'phone']} · {c.owner}: {contact.owner_id ? nameOf(contact.owner_id as string) : c.unassigned}
        </span>
      </p>
      {erased ? <Notice tone="info">{c.erased}</Notice> : null}

      {canManage ? (
        <section aria-labelledby="det-h" className="space-y-3">
          <h2 id="det-h" className="text-xl font-bold">
            {c.details}
          </h2>
          <ActionForm action={updateContactAction} submitLabel={c.save} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ fullName: c.fullName, phone: c.phone, email: c.email }} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="contactId" value={id} />
            <Field name="fullName" label={c.fullName} required maxLength={120} defaultValue={contact.full_name as string} idPrefix="cd" />
            <SelectField name="source" label={c.source} defaultValue={contact.source as string} idPrefix="cd">
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {c.sources[s]}
                </option>
              ))}
            </SelectField>
            <Field name="phone" label={c.phone} type="tel" maxLength={20} defaultValue={(contact.phone as string | null) ?? ''} idPrefix="cd" />
            <Field name="email" label={c.email} type="email" maxLength={254} defaultValue={(contact.email as string | null) ?? ''} idPrefix="cd" />
            <TextareaField name="note" label={c.note} maxLength={2000} rows={2} defaultValue={(contact.note as string | null) ?? ''} idPrefix="cd" />
          </ActionForm>

          <div className="grid gap-4 lg:grid-cols-2">
            {stage !== 'won' ? (
              <ActionForm action={setStageAction} submitLabel={c.changeStage} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ lostReason: c.lostReason }} className="space-y-3">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="contactId" value={id} />
                <SelectField name="stage" label={c.stage} defaultValue={stage} idPrefix="st">
                  {STAGES.filter((s) => s !== 'won').map((s) => (
                    <option key={s} value={s}>
                      {c.stages[s]}
                    </option>
                  ))}
                </SelectField>
                <Field name="lostReason" label={c.lostReason} maxLength={300} defaultValue={(contact.lost_reason as string | null) ?? ''} idPrefix="st" />
              </ActionForm>
            ) : null}
            <ActionForm action={assignOwnerAction} submitLabel={c.assign} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ ownerId: c.owner }} className="space-y-3">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="contactId" value={id} />
              <SelectField name="ownerId" label={c.owner} defaultValue={(contact.owner_id as string | null) ?? ''} idPrefix="ow">
                <option value="">{c.unassigned}</option>
                {salesPeople.map((p) => (
                  <option key={p} value={p}>
                    {nameOf(p)}
                  </option>
                ))}
              </SelectField>
            </ActionForm>
          </div>
        </section>
      ) : null}

      {canManage ? (
        <section aria-labelledby="log-h" className="space-y-3">
          <h2 id="log-h" className="text-xl font-bold">
            {c.logTitle}
          </h2>
          <ActionForm action={logCommunicationAction} submitLabel={c.logSubmit} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ body: c.body }} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="contactId" value={id} />
            <input type="hidden" name="organizationId" value={org} />
            <SelectField name="kind" label={c.kind} idPrefix="lg">
              {(['call', 'message', 'meeting', 'note'] as const).map((k) => (
                <option key={k} value={k}>
                  {c.logKinds[k]}
                </option>
              ))}
            </SelectField>
            <SelectField name="channel" label={c.channel} idPrefix="lg">
              <option value="">—</option>
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {c.channels[ch]}
                </option>
              ))}
            </SelectField>
            <TextareaField name="body" label={c.body} required maxLength={4000} rows={2} idPrefix="lg" />
          </ActionForm>
        </section>
      ) : null}

      <section aria-labelledby="rem-h" className="space-y-3">
        <h2 id="rem-h" className="text-xl font-bold">
          {c.remindersTitle}
        </h2>
        <ul className="space-y-2">
          {(reminders.data ?? []).map((r) => (
            <li key={r.id as string} className="flex flex-wrap items-center gap-3">
              <span>
                {fmt(c.due, { date: formatShortDateTime(locale, r.due_at as string, tz) })} · {nameOf(r.assignee_id as string)}
                {r.note ? ` — ${r.note as string}` : ''}
              </span>
              {r.status === 'open' && canManage ? (
                <>
                  <ActionForm action={completeReminderAction} submitLabel={c.done} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="reminderId" value={r.id as string} />
                    <input type="hidden" name="status" value="done" />
                  </ActionForm>
                  <ActionForm action={completeReminderAction} submitLabel={c.cancel} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="reminderId" value={r.id as string} />
                    <input type="hidden" name="status" value="cancelled" />
                  </ActionForm>
                </>
              ) : (
                <Badge>{r.status === 'done' ? c.done : r.status === 'cancelled' ? c.cancel : c.overdue}</Badge>
              )}
            </li>
          ))}
        </ul>
        {canManage ? (
          <ActionForm action={addReminderAction} submitLabel={c.addReminder} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ dueAt: c.dueAt, assigneeId: c.assignee }} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="contactId" value={id} />
            <input type="hidden" name="organizationId" value={org} />
            <input type="hidden" name="timezone" value={tz} />
            <Field name="dueAt" label={c.dueAt} type="datetime-local" required idPrefix="rm" />
            <SelectField name="assigneeId" label={c.assignee} defaultValue={ctx.user.id} idPrefix="rm">
              {salesPeople.map((p) => (
                <option key={p} value={p}>
                  {nameOf(p)}
                </option>
              ))}
            </SelectField>
            <Field name="note" label={c.reminderNote} maxLength={500} idPrefix="rm" />
          </ActionForm>
        ) : null}
      </section>

      <section aria-labelledby="trial-h" className="space-y-3">
        <h2 id="trial-h" className="text-xl font-bold">
          {c.trialTitle}
        </h2>
        <ul className="space-y-2">
          {(bookings.data ?? []).map((b) => {
            const slot = one(b.trial_slots as unknown as { period: string } | null);
            return (
              <li key={b.id as string} className="flex flex-wrap items-center gap-3">
                <span>{slot ? formatShortDateTime(locale, parsePeriod(slot.period)[0], tz) : '—'}</span>
                <Badge tone={b.status === 'attended' ? 'success' : b.status === 'booked' ? 'neutral' : 'warning'}>{c.bookingStatuses[b.status as 'booked']}</Badge>
                {canManage && b.status === 'booked'
                  ? (
                      [
                        ['attended', c.markAttended],
                        ['no_show', c.markNoShow],
                        ['cancelled', c.markCancelled],
                      ] as const
                    ).map(([status, label]) => (
                      <ActionForm key={status} action={trialResultAction} submitLabel={label} pendingLabel={t.common.pending} messages={msg} variant="secondary">
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="bookingId" value={b.id as string} />
                        <input type="hidden" name="status" value={status} />
                      </ActionForm>
                    ))
                  : null}
              </li>
            );
          })}
        </ul>
        {canManage ? (
          futureSlots.length ? (
            <ActionForm action={bookTrialAction} submitLabel={c.book} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ slotId: c.slot }} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="contactId" value={id} />
              <SelectField name="slotId" label={c.slot} idPrefix="bk">
                {futureSlots.map((s) => (
                  <option key={s.id as string} value={s.id as string}>
                    {formatShortDateTime(locale, parsePeriod(s.period as string)[0], tz)} · {s.format as string}
                  </option>
                ))}
              </SelectField>
            </ActionForm>
          ) : (
            <p className="text-muted">{c.noSlots}</p>
          )
        ) : null}
      </section>

      <section aria-labelledby="conv-h" className="space-y-3">
        <h2 id="conv-h" className="text-xl font-bold">
          {c.convertTitle}
        </h2>
        {contact.profile_id ? (
          <p>{fmt(c.convertedAs, { name: nameOf(contact.profile_id as string) })}</p>
        ) : canManage ? (
          <>
            <p className="text-sm text-muted">{c.convertHint}</p>
            <ActionForm action={convertAction} submitLabel={c.convert} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ profileId: c.student }} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="contactId" value={id} />
              <SelectField name="profileId" label={c.student} idPrefix="cv">
                {studentIds.map((p) => (
                  <option key={p} value={p}>
                    {nameOf(p)}
                  </option>
                ))}
              </SelectField>
            </ActionForm>
          </>
        ) : null}
        {contact.profile_id && !erased ? (
          <ActionForm action={enrollAction} submitLabel={c.enroll} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ groupId: c.group }} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="contactId" value={id} />
            <SelectField name="groupId" label={`${c.enrollTitle}: ${c.group}`} idPrefix="en">
              {(groups.data ?? [])
                .filter((g) => inBranch(g.branch_id) && can(m, 'enrollment.manage', org, g.branch_id as string))
                .map((g) => (
                  <option key={g.id as string} value={g.id as string}>
                    {g.name as string}
                  </option>
                ))}
            </SelectField>
          </ActionForm>
        ) : null}
      </section>

      {(requests.data ?? []).length ? (
        <section aria-labelledby="req-h" className="space-y-2">
          <h2 id="req-h" className="text-xl font-bold">
            {c.requestsTitle}
          </h2>
          <ul className="space-y-1 text-sm">
            {(requests.data ?? []).map((r) => (
              <li key={r.id as string}>
                {formatShortDateTime(locale, r.created_at as string, tz)} · {c.sources[r.kind === 'trial' ? 'website_trial' : 'website_contact']}
                {r.message ? ` — ${r.message as string}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="hist-h" className="space-y-2">
        <h2 id="hist-h" className="text-xl font-bold">
          {c.historyTitle}
        </h2>
        <ol className="space-y-2">
          {(events.data ?? []).map((e) => (
            <li key={String(e.id)} className="rounded-[var(--radius-control)] border border-border px-3 py-2 text-sm">
              <span className="text-muted">{formatShortDateTime(locale, e.created_at as string, tz)}</span> · <strong>{c.events[e.kind as 'note']}</strong>
              {e.channel ? ` (${c.channels[e.channel as 'phone']})` : ''}
              {e.kind === 'stage_changed' ? `: ${e.from_stage ? c.stages[e.from_stage as 'new'] : '—'} → ${c.stages[e.to_stage as 'new']}` : ''}
              {e.kind === 'assigned' ? `: ${e.body ? nameOf(e.body as string) : c.unassigned}` : ''}
              {e.kind === 'trial_result' && e.body ? `: ${c.bookingStatuses[e.body as 'booked']}` : ''}
              {e.actor_id ? ` · ${c.by}: ${nameOf(e.actor_id as string)}` : ''}
              {e.body && !['assigned', 'trial_result', 'trial_booked'].includes(e.kind as string) ? <p className="mt-1 whitespace-pre-wrap">{e.body as string}</p> : null}
            </li>
          ))}
        </ol>
      </section>

      {isAdmin ? (
        <Card className="space-y-3">
          <h2 className="text-xl font-bold">{c.eraseTitle}</h2>
          <p className="text-sm">{c.eraseHint}</p>
          <ActionForm
            action={eraseContactAction}
            submitLabel={c.erase}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ reason: c.eraseReason }}
            variant="danger"
            confirm={{ title: c.eraseConfirmTitle, text: c.eraseConfirmText, confirmLabel: c.erase, cancelLabel: c.keep }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="contactId" value={id} />
            <Field name="reason" label={c.eraseReason} required minLength={3} maxLength={300} idPrefix="er" />
          </ActionForm>
        </Card>
      ) : null}
    </WorkspacePage>
  );
}
