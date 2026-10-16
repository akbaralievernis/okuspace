'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import { buttonClasses } from './button';

/** Кнопка отправки: блокируется на время запроса, чтобы не было повторной отправки. */
export function SubmitButton({ children, pendingLabel, variant = 'primary' }: { children: ReactNode; pendingLabel: string; variant?: 'primary' | 'danger' | 'secondary' }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={buttonClasses(variant)}>
      {pending ? pendingLabel : children}
    </button>
  );
}
