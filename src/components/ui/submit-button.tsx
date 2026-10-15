'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

/** Кнопка отправки: блокируется на время запроса, чтобы не было повторной отправки. */
export function SubmitButton({ children, pendingLabel, variant = 'primary' }: { children: ReactNode; pendingLabel: string; variant?: 'primary' | 'danger' | 'secondary' }) {
  const { pending } = useFormStatus();
  const styles = {
    primary: 'bg-brand-700 text-white hover:bg-brand-600',
    danger: 'bg-red-700 text-white hover:bg-red-800',
    secondary: 'border border-gray-400 bg-white text-ink hover:bg-gray-100',
  }[variant];
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 font-medium disabled:opacity-60 ${styles}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
