import type { ReactNode } from 'react';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const tones: Record<NoticeTone, string> = {
  info: 'border-info-800 bg-info-50 text-info-800',
  success: 'border-success-800 bg-success-50 text-success-800',
  warning: 'border-warning-800 bg-warning-50 text-warning-800',
  error: 'border-danger-700 bg-danger-50 text-danger-700',
};

/**
 * Уведомление. live=true — для сообщений, появляющихся после действия пользователя
 * (ошибка → role="alert", остальное → role="status"); статичные уведомления не объявляются.
 */
export function Notice({ tone = 'info', title, children, live = false }: { tone?: NoticeTone; title?: string; children?: ReactNode; live?: boolean }) {
  const role = live ? (tone === 'error' ? 'alert' : 'status') : undefined;
  return (
    <div role={role} className={`rounded-[var(--radius-control)] border-l-4 px-4 py-3 text-sm ${tones[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
    </div>
  );
}

/** Пустое состояние списка: что здесь будет и (необязательно) что сделать. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border-strong bg-surface-muted px-6 py-10 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-prose text-muted">{children}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'warning' | 'success' }) {
  const styles = {
    neutral: 'bg-surface-muted text-ink border-border',
    brand: 'bg-brand-50 text-brand-800 border-brand-100',
    warning: 'bg-warning-50 text-warning-800 border-accent-100',
    success: 'bg-success-50 text-success-800 border-success-50',
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm font-medium ${styles}`}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-sm ${className}`}>{children}</div>;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-[var(--radius-control)] bg-surface-muted ${className}`} />;
}

export function PageHeader({ title, lead, children }: { title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="mb-8 space-y-3">
      <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
      {lead ? <p className="max-w-prose text-lg text-muted">{lead}</p> : null}
      {children}
    </div>
  );
}
