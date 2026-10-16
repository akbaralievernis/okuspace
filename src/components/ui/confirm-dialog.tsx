'use client';

import { useId, useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './button';

/**
 * Подтверждение опасного действия на нативном <dialog>: фокус переходит в диалог,
 * Esc закрывает, фокус возвращается на кнопку. Подтверждение отправляет форму-владельца
 * через requestSubmit(), поэтому срабатывает серверная валидация и обычный поток ошибок.
 */
export function ConfirmSubmit({
  label,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
}: {
  label: string;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: ButtonVariant;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  const close = () => {
    dialog.current?.close();
    opener.current?.focus();
  };

  return (
    <>
      <Button ref={opener} variant={variant} onClick={() => dialog.current?.showModal()}>
        {label}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-[var(--radius-card)] border border-border p-6 shadow-xl"
        onClose={() => opener.current?.focus()}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {description ? (
          <div id={descId} className="mt-2 text-muted">
            {description}
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close} autoFocus>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            onClick={() => {
              const form = opener.current?.closest('form');
              dialog.current?.close();
              form?.requestSubmit();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </>
  );
}
