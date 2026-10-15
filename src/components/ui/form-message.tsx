import type { FormState } from '@/server/auth/use-cases';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { fmt } from '@/lib/format';

export type AuthMessages = Pick<Dictionary['auth'], 'errors' | 'fieldErrors' | 'success'>;

/** Общее сообщение формы: ошибки — role="alert", успех — role="status". */
export function FormMessage({ state, messages }: { state: FormState; messages: AuthMessages }) {
  if (state.status === 'error') {
    return (
      <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-800">
        {messages.errors[state.code]}
      </p>
    );
  }
  if (state.status === 'success') {
    return (
      <p role="status" className="rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-900">
        {fmt(messages.success[state.code], state.data ?? {})}
      </p>
    );
  }
  return null;
}

/** Тексты ошибок конкретного поля. */
export function fieldMessages(state: FormState, field: string, messages: AuthMessages): string[] | undefined {
  if (state.status !== 'error' || !state.fieldErrors?.[field]) return undefined;
  return state.fieldErrors[field].map((code) => messages.fieldErrors[code]);
}
