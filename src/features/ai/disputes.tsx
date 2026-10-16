import { SelectField, TextareaField } from '@/components/ui/controls';
import { Badge } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { authMessages } from '@/features/admin/workspace-page';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { openDisputeAction, resolveDisputeAction } from '@/server/ai/actions';

export interface Dispute {
  id: string;
  openedBy: string;
  openedByName: string;
  comment: string;
  status: 'open' | 'upheld' | 'rejected';
  resolution: string | null;
}

/** Споры по AI-отзыву: список, форма «оспорить» (ученик/преподаватель), решение (преподаватель). */
export function Disputes({
  feedbackId,
  disputes,
  canOpen,
  canResolve,
  locale,
  t,
}: {
  feedbackId: string;
  disputes: Dispute[];
  canOpen: boolean;
  canResolve: boolean;
  locale: string;
  t: Dictionary;
}) {
  const a = t.ai;
  const msg = authMessages(t);
  return (
    <section aria-labelledby="disp-h" className="space-y-3">
      <h2 id="disp-h" className="text-xl font-bold">
        {a.disputesTitle}
      </h2>
      <ul className="space-y-3">
        {disputes.map((d) => (
          <li key={d.id} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
            <p className="flex flex-wrap items-center gap-2">
              <strong>{d.openedByName}</strong>
              <Badge tone={d.status === 'open' ? 'warning' : d.status === 'upheld' ? 'success' : 'neutral'}>{a.disputeStatuses[d.status]}</Badge>
            </p>
            <p className="whitespace-pre-wrap">{d.comment}</p>
            {d.resolution ? (
              <p className="text-sm">
                <strong>{a.resolution}:</strong> {d.resolution}
              </p>
            ) : null}
            {canResolve && d.status === 'open' ? (
              <ActionForm action={resolveDisputeAction} submitLabel={a.resolve} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ resolution: a.resolution }} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="disputeId" value={d.id} />
                <SelectField name="decision" label={a.decision} idPrefix={`r-${d.id}`}>
                  <option value="upheld">{a.decisions.upheld}</option>
                  <option value="rejected">{a.decisions.rejected}</option>
                </SelectField>
                <TextareaField name="resolution" label={a.resolution} required maxLength={2000} rows={2} idPrefix={`r-${d.id}`} />
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
      {canOpen ? (
        <ActionForm action={openDisputeAction} submitLabel={a.disputeSubmit} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ comment: a.disputeComment }} variant="secondary">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="feedbackId" value={feedbackId} />
          <TextareaField name="comment" label={a.disputeComment} required minLength={3} maxLength={2000} rows={3} idPrefix="dispute" />
        </ActionForm>
      ) : null}
    </section>
  );
}
