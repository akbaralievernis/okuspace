'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

export interface NavItem {
  href: string;
  label: string;
}

/**
 * Меню для узких экранов: кнопка-раскрывашка (aria-expanded/aria-controls),
 * Esc закрывает и возвращает фокус на кнопку, нажатие на ссылку закрывает меню.
 */
export function MobileMenu({ items, label, openLabel, closeLabel }: { items: NavItem[]; label: string; openLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-border-strong px-3"
      >
        {open ? closeLabel : openLabel}
      </button>
      <nav id={panelId} aria-label={label} hidden={!open} className="absolute inset-x-0 top-full z-20 border-b border-border bg-surface shadow-lg">
        <ul className="container-page grid gap-1 py-3">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className="flex min-h-11 items-center rounded-[var(--radius-control)] px-3 hover:bg-surface-muted aria-[current=page]:font-semibold aria-[current=page]:text-brand-800"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
