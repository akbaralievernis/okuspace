import Link from 'next/link';
import type { Dictionary } from '@/i18n/dictionaries/ru';

/** Разделы финансов. */
export function FinanceTabs({ locale, t, current }: { locale: string; t: Dictionary; current: 'overview' | 'invoices' | 'billing' | 'payroll' | 'payments' | 'expenses' | 'prices' }) {
  const f = t.finance;
  const items = [
    ['overview', '/finance', f.overview],
    ['invoices', '/finance/invoices', f.invoices],
    ['billing', '/finance/billing', t.auto.billing.title],
    ['payroll', '/payroll', t.auto.payroll.title],
    ['payments', '/finance/payments', f.payments],
    ['expenses', '/finance/expenses', f.expenses],
    ['prices', '/finance/prices', f.prices],
  ] as const;
  return (
    <nav aria-label={f.title} className="flex flex-wrap gap-2">
      {items.map(([key, path, label]) => (
        <Link
          key={key}
          href={`/${locale}/app${path}`}
          aria-current={current === key ? 'page' : undefined}
          className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-border px-3 text-ink no-underline hover:bg-surface-muted aria-[current=page]:border-brand-700 aria-[current=page]:font-semibold"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
