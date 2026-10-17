'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './brand';

/**
 * Плавающая кнопка WhatsApp: один филиал — сразу чат; несколько — выбор филиала.
 * Esc закрывает список и возвращает фокус на кнопку.
 */
export function WhatsAppFab({ branches, label, chooseLabel, closeLabel }: { branches: { id: string; name: string; phone: string }[]; label: string; chooseLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const link = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}`;

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

  const fab = 'fixed bottom-4 right-4 z-50 inline-flex size-14 items-center justify-center rounded-full bg-brand-700 text-white shadow-[var(--shadow-card)] hover:bg-brand-800 sm:bottom-6 sm:right-6';
  if (branches.length === 1) {
    return (
      <a href={link(branches[0]!.phone)} className={fab} aria-label={`${label}: ${branches[0]!.name}`} rel="noopener noreferrer" target="_blank">
        <Icon name="whatsapp" className="size-7" />
      </a>
    );
  }
  return (
    <>
      {open ? (
        <div id={panelId} role="dialog" aria-label={chooseLabel} className="fixed bottom-20 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] border border-border bg-surface p-3 shadow-[var(--shadow-card)] sm:bottom-24 sm:right-6">
          <p className="mb-2 px-1 text-sm font-bold uppercase text-heading">{chooseLabel}</p>
          <ul className="space-y-1">
            {branches.map((b) => (
              <li key={b.id}>
                <a href={link(b.phone)} rel="noopener noreferrer" target="_blank" className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-2 font-semibold text-ink no-underline hover:bg-brand-50">
                  <Icon name="whatsapp" className="size-5 text-brand-700" />
                  {b.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button ref={button} type="button" className={fab} aria-expanded={open} aria-controls={panelId} aria-label={open ? closeLabel : label} onClick={() => setOpen((v) => !v)}>
        <Icon name="whatsapp" className="size-7" />
      </button>
    </>
  );
}
