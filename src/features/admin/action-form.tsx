'use client';

import { useActionState, type ReactNode } from 'react';
import { ConfirmSubmit } from '@/components/ui/confirm-dialog';
import { FormMessage, type AuthMessages } from '@/components/ui/form-message';
import { SubmitButton } from '@/components/ui/submit-button';
import type { FormState } from '@/server/auth/use-cases';

const idle: FormState = { status: 'idle' };

export interface ConfirmSpec {
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * Форма Server Action для кабинета: общее сообщение, сводка ошибок полей
 * (с подписями полей) и кнопка отправки; для опасных действий — подтверждение в диалоге.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  messages,
  fieldLabels = {},
  confirm,
  variant = 'primary',
  className = 'space-y-4',
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  messages: AuthMessages;
  fieldLabels?: Record<string, string>;
  confirm?: ConfirmSpec;
  variant?: 'primary' | 'secondary' | 'danger';
  className?: string;
}) {
  const [state, formAction] = useActionState(action, idle);
  const fieldErrors = state.status === 'error' ? Object.entries(state.fieldErrors ?? {}) : [];
  return (
    <form action={formAction} className={className} noValidate>
      {children}
      {state.status !== 'idle' ? <FormMessage state={state} messages={messages} /> : null}
      {fieldErrors.length ? (
        <ul className="list-disc pl-6 text-sm text-danger-700">
          {fieldErrors.flatMap(([field, codes]) =>
            codes.map((code) => (
              <li key={`${field}-${code}`}>
                {fieldLabels[field] ? `${fieldLabels[field]}: ` : ''}
                {messages.fieldErrors[code]}
              </li>
            )),
          )}
        </ul>
      ) : null}
      <div>
        {confirm ? (
          <ConfirmSubmit label={submitLabel} title={confirm.title} description={confirm.text} confirmLabel={confirm.confirmLabel} cancelLabel={confirm.cancelLabel} variant={variant === 'danger' ? 'danger' : 'primary'} />
        ) : (
          <SubmitButton pendingLabel={pendingLabel} variant={variant}>
            {submitLabel}
          </SubmitButton>
        )}
      </div>
    </form>
  );
}
