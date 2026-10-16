import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';

/**
 * Карточка страниц входа/регистрации внутри общего каркаса сайта ((site)/layout.tsx):
 * шапку, <main> и подвал даёт layout.
 */
export function AuthShell({ title, children, footer }: { locale?: Locale; t?: Dictionary; title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="mb-6 text-2xl font-bold">{title}</h1>
      {children}
      {footer ? <div className="mt-6 space-y-2 text-sm">{footer}</div> : null}
    </div>
  );
}
