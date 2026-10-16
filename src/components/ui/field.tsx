import type { InputHTMLAttributes } from 'react';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  name: string;
  /** Префикс id, если на странице несколько форм с одинаковыми полями. */
  idPrefix?: string;
  label: string;
  hint?: string;
  errors?: string[] | undefined;
}

/** Поле формы: подпись, подсказка и ошибки связаны с input через aria-describedby. */
export function Field({ name, label, hint, errors, idPrefix = 'field', ...input }: FieldProps) {
  const id = `${idPrefix}-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = errors?.length ? `${id}-error` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className="block min-h-11 w-full rounded-md border border-border-strong px-3 py-2 text-base aria-[invalid=true]:border-danger-700"
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {errorId ? (
        <ul id={errorId} className="text-sm text-danger-700">
          {errors!.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
