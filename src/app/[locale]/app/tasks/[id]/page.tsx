import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TextareaField } from '@/components/ui/controls';
import { Badge, Card } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { taskCommentAction, taskReviewAction, taskWorkAction } from '@/server/management/actions';
import { isOverdue } from '@/server/management/period';
import { createUserClient } from '@/server/supabase/server';

export default async function TaskPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/tasks/${id}`);
  const t = getDictionary(locale);
  const k = t.mgmt.tasks;
  const msg = authMessages(t);
  const db = await createUserClient();
  // RLS: задачу видят исполнитель и руководители её охвата.
  const { data: task } = await db
    .from('staff_tasks')
    .select('id, organization_id, branch_id, title, description, priority, status, due_at, assignee_id, created_by, result_note, submitted_at, completed_at, cancel_reason, created_at, organizations(default_timezone), branches(name)')
    .eq('id', id)
    .maybeSingle();
  if (!task) notFound();
  const [{ data: events }] = await Promise.all([
    db.from('staff_task_events').select('id, kind, body, actor_id, created_at').eq('task_id', id).order('created_at', { ascending: true }),
  ]);
  const ids = [...new Set([task.assignee_id as string, task.created_by as string, ...(events ?? []).map((e) => e.actor_id as string | null).filter((x): x is string => Boolean(x))])];
  const { data: people } = await db.from('profiles').select('id, full_name').in('id', ids);
  const nameOf = (pid: string | null) => (pid ? ((people ?? []).find((p) => p.id === pid)?.full_name as string) || '—' : '—');
  const org = task.organization_id as string;
  const branch = (task.branch_id as string | null) ?? null;
  const tz = (task.organizations as unknown as { default_timezone: string } | null)?.default_timezone ?? DEFAULT_TIMEZONE;
  const branchName = (task.branches as unknown as { name: string } | null)?.name ?? k.wholeSchool;
  const status = task.status as string;
  const m = ctx.memberships;
  const isAssignee = task.assignee_id === ctx.user.id;
  // Как в БД: принимает автор задачи или директор школы, но не сам исполнитель.
  const canReview = !isAssignee && can(m, 'task.manage', org, branch) && (task.created_by === ctx.user.id || can(m, 'task.manage', org, null));
  const canComment = isAssignee || can(m, 'task.manage', org, branch);
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="taskId" value={id} />
    </>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={task.title as string}>
      <p>
        <Link className="link" href={`/${locale}/app/tasks`}>
          {k.back}
        </Link>
      </p>
      <Card>
        <p className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={status === 'done' ? 'success' : status === 'submitted' ? 'brand' : 'neutral'}>{k.status[status as keyof typeof k.status]}</Badge>
          {isOverdue(status, task.due_at as string | null) ? <Badge tone="warning">{k.overdue}</Badge> : null}
          <Badge tone={task.priority === 'high' || task.priority === 'urgent' ? 'warning' : 'neutral'}>{k.priority[task.priority as keyof typeof k.priority]}</Badge>
        </p>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">{k.assignee}</dt>
          <dd>{nameOf(task.assignee_id as string)}</dd>
          <dt className="text-muted">{k.author}</dt>
          <dd>{nameOf(task.created_by as string)}</dd>
          <dt className="text-muted">{k.branch}</dt>
          <dd>{branchName}</dd>
          <dt className="text-muted">{k.due}</dt>
          <dd>{task.due_at ? formatShortDateTime(locale, task.due_at as string, tz) : k.noDue}</dd>
          <dt className="text-muted">{k.created}</dt>
          <dd>{formatShortDateTime(locale, task.created_at as string, tz)}</dd>
        </dl>
        {task.description ? <p className="mt-4 whitespace-pre-wrap">{task.description as string}</p> : null}
      </Card>

      {task.result_note ? (
        <Card>
          <h2 className="mb-2 text-lg font-bold">{k.result}</h2>
          <p className="whitespace-pre-wrap">{task.result_note as string}</p>
        </Card>
      ) : null}

      {isAssignee && status === 'open' ? (
        <ActionForm action={taskWorkAction} submitLabel={k.start} pendingLabel={t.common.pending} messages={msg} variant="secondary">
          {hidden}
          <input type="hidden" name="action" value="start" />
        </ActionForm>
      ) : null}
      {isAssignee && (status === 'open' || status === 'in_progress') ? (
        <Card>
          <ActionForm action={taskWorkAction} submitLabel={k.submit} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ note: k.report }}>
            {hidden}
            <input type="hidden" name="action" value="submit" />
            <TextareaField name="note" label={k.report} required maxLength={5000} idPrefix="sub" />
          </ActionForm>
        </Card>
      ) : null}

      {canReview && status === 'submitted' ? (
        <Card className="space-y-4">
          <ActionForm action={taskReviewAction} submitLabel={k.accept} pendingLabel={t.common.pending} messages={msg}>
            {hidden}
            <input type="hidden" name="action" value="accept" />
          </ActionForm>
          <ActionForm action={taskReviewAction} submitLabel={k.returnLabel} pendingLabel={t.common.pending} messages={msg} variant="secondary" fieldLabels={{ note: k.returnComment }}>
            {hidden}
            <input type="hidden" name="action" value="return" />
            <TextareaField name="note" label={k.returnComment} required maxLength={5000} idPrefix="ret" />
          </ActionForm>
        </Card>
      ) : null}
      {canReview && ['open', 'in_progress', 'submitted'].includes(status) ? (
        <ActionForm
          action={taskReviewAction}
          submitLabel={k.cancel}
          pendingLabel={t.common.pending}
          messages={msg}
          variant="danger"
          fieldLabels={{ note: k.cancelReason }}
          confirm={{ title: k.cancel, text: k.cancelConfirm, confirmLabel: k.cancel, cancelLabel: k.keep }}
        >
          {hidden}
          <input type="hidden" name="action" value="cancel" />
          <TextareaField name="note" label={k.cancelReason} required maxLength={500} rows={2} idPrefix="can" />
        </ActionForm>
      ) : null}

      <section aria-labelledby="hist-h" className="space-y-3">
        <h2 id="hist-h" className="text-xl font-bold">
          {k.history}
        </h2>
        <ol className="space-y-2">
          {(events ?? []).map((e) => (
            <li key={e.id as string} className="rounded-[var(--radius-control)] border border-border px-3 py-2 text-sm">
              <p>
                <span className="font-semibold">{nameOf(e.actor_id as string | null)}</span> — {k.events[e.kind as keyof typeof k.events]}{' '}
                <span className="text-muted">{formatShortDateTime(locale, e.created_at as string, tz)}</span>
              </p>
              {e.body ? <p className="mt-1 whitespace-pre-wrap">{e.body as string}</p> : null}
            </li>
          ))}
        </ol>
        {canComment ? (
          <ActionForm action={taskCommentAction} submitLabel={k.addComment} pendingLabel={t.common.pending} messages={msg} variant="secondary" fieldLabels={{ note: k.comment }}>
            {hidden}
            <TextareaField name="note" label={k.comment} required maxLength={2000} rows={3} idPrefix="com" />
          </ActionForm>
        ) : null}
      </section>
    </WorkspacePage>
  );
}
