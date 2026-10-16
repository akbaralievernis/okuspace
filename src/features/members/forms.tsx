'use client';

import { useActionState, useMemo, useState } from 'react';
import { ConfirmSubmit } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { FormMessage, fieldMessages, type AuthMessages } from '@/components/ui/form-message';
import { SubmitButton } from '@/components/ui/submit-button';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { fmt } from '@/lib/format';
import { acceptInvitationAction, inviteMemberAction, setMembershipStatusAction, signOutOthersAction } from '@/server/auth/actions';
import type { FormState } from '@/server/auth/use-cases';
import type { Role } from '@/server/authz/permissions';

const idle: FormState = { status: 'idle' };

export interface InviteScope {
  organizationId: string;
  organizationName: string;
  branchId: string | null;
  branchName: string | null;
  roles: Role[];
}

/** Приглашение: роли в списке зависят от выбранного охвата (школа/филиал). Права всё равно проверяет сервер и RLS. */
export function InviteForm({ locale, scopes, t, pending }: { locale: Locale; scopes: InviteScope[]; t: Dictionary; pending: string }) {
  const [state, action] = useActionState(inviteMemberAction, idle);
  const [scopeKey, setScopeKey] = useState(0);
  const scope = scopes[scopeKey];
  const messages: AuthMessages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const roles = useMemo(() => scope?.roles ?? [], [scope]);
  if (!scope) return null;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organizationId" value={scope.organizationId} />
      <input type="hidden" name="branchId" value={scope.branchId ?? ''} />
      <FormMessage state={state} messages={messages} />
      {state.status === 'success' && state.data?.link ? (
        <div className="rounded-md border border-border bg-surface-muted p-3 text-sm">
          <p>{t.app.members.inviteLinkLabel}</p>
          <code className="mt-1 block break-all font-mono">{state.data.link}</code>
        </div>
      ) : null}
      <div className="space-y-1">
        <label htmlFor="invite-scope" className="block text-sm font-medium">
          {t.app.organization} / {t.app.branch}
        </label>
        <select
          id="invite-scope"
          className="block min-h-11 w-full rounded-md border border-border-strong px-3"
          value={scopeKey}
          onChange={(e) => setScopeKey(Number(e.target.value))}
        >
          {scopes.map((s, i) => (
            <option key={`${s.organizationId}:${s.branchId}`} value={i}>
              {s.organizationName} — {s.branchName ?? t.app.members.wholeOrganizationOption}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="invite-role" className="block text-sm font-medium">
          {t.app.role}
        </label>
        <select id="invite-role" name="role" required className="block min-h-11 w-full rounded-md border border-border-strong px-3">
          {roles.map((r) => (
            <option key={r} value={r}>
              {t.roles[r]}
            </option>
          ))}
        </select>
      </div>
      <Field name="email" type="email" label={t.auth.email} autoComplete="off" required errors={fieldMessages(state, 'email', messages)} />
      <SubmitButton pendingLabel={pending}>{t.app.members.inviteSubmit}</SubmitButton>
    </form>
  );
}

/** Блокировка / восстановление / отзыв роли с подтверждением и причиной. */
export function MemberStatusForm({
  locale,
  membershipId,
  target,
  name,
  t,
  pending,
}: {
  locale: Locale;
  membershipId: string;
  target: 'active' | 'blocked' | 'revoked';
  name: string;
  t: Dictionary;
  pending: string;
}) {
  const [state, action] = useActionState(setMembershipStatusAction, idle);
  const messages: AuthMessages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const label = target === 'active' ? t.app.members.restore : target === 'blocked' ? t.app.members.block : t.app.members.revoke;
  const reasonId = `reason-${membershipId}-${target}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="status" value={target} />
      {target !== 'active' ? (
        <span className="space-y-1">
          <label htmlFor={reasonId} className="sr-only">
            {t.app.members.reason}
          </label>
          <input
            id={reasonId}
            name="reason"
            required
            minLength={3}
            placeholder={t.app.members.reason}
            className="min-h-11 w-40 rounded-md border border-border-strong px-2"
          />
        </span>
      ) : null}
      {target === 'active' ? (
        <SubmitButton pendingLabel={pending} variant="secondary">
          {label}
        </SubmitButton>
      ) : (
        <ConfirmSubmit
          label={label}
          title={fmt(t.app.members.confirm, { action: label, name })}
          confirmLabel={label}
          cancelLabel={t.admin.common.cancel}
          variant="danger"
        />
      )}
      {state.status !== 'idle' ? <FormMessage state={state} messages={messages} /> : null}
    </form>
  );
}

export function SignOutOthersForm({ locale, t, pending }: { locale: Locale; t: Dictionary; pending: string }) {
  const [state, action] = useActionState(signOutOthersAction, idle);
  const messages: AuthMessages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="locale" value={locale} />
      <FormMessage state={state} messages={messages} />
      <SubmitButton pendingLabel={pending} variant="secondary">
        {t.app.account.signOutOthers}
      </SubmitButton>
    </form>
  );
}

export function AcceptInvitationForm({ locale, token, t, pending }: { locale: Locale; token: string; t: Dictionary; pending: string }) {
  const [state, action] = useActionState(acceptInvitationAction, idle);
  const messages: AuthMessages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} messages={messages} />
      <SubmitButton pendingLabel={pending}>{t.app.invite.accept}</SubmitButton>
    </form>
  );
}
