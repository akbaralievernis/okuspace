import Link from 'next/link';
import type { ComponentProps } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'cta' | 'outline';
export type ButtonSize = 'md' | 'lg';

/** Единые стили кнопок и ссылок-кнопок. Минимальная цель нажатия — 44×44 px. */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra = ''): string {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium no-underline transition disabled:cursor-not-allowed disabled:opacity-60';
  const sizes =
    variant === 'cta' || variant === 'outline'
      ? { md: 'min-h-12 px-5 py-2 text-sm', lg: 'min-h-12 px-6 py-3 text-[0.9375rem]' }[size]
      : { md: 'min-h-11 px-4 py-2 text-base', lg: 'min-h-12 px-6 py-3 text-lg' }[size];
  const variants = {
    primary: 'bg-brand-700 text-white hover:bg-brand-800',
    secondary: 'border border-border-strong bg-surface text-ink hover:bg-surface-muted',
    danger: 'bg-danger-700 text-white hover:bg-danger-800',
    ghost: 'text-brand-700 hover:bg-brand-50',
    // Кнопки публичного сайта в фирменном стиле: капс, жирный, лёгкий подъём при наведении.
    cta: 'bg-brand-700 font-bold uppercase tracking-[0.02em] text-white shadow-[var(--shadow-card)] hover:-translate-y-0.5 hover:bg-brand-800',
    outline: 'border-2 border-brand-700 bg-surface font-bold uppercase tracking-[0.02em] text-brand-700 hover:-translate-y-0.5 hover:bg-brand-50',
  }[variant];
  return [base, sizes, variants, extra].filter(Boolean).join(' ');
}

export function Button({
  variant,
  size,
  className = '',
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant,
  size,
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}
