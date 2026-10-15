import type { InputHTMLAttributes } from 'react';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  name: string;
  label: string;
  hint?: string;
  errors?: string[] | undefined;
}

/** Поле формы: подпись, подсказка и ошибки связаны с input через aria-describedby. */
export function Field({ name, label, hint, errors, ...input }: FieldProps) {
  const id = `field-${name}`;
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
        className="block min-h-11 w-full rounded-md border border-gray-400 px-3 py-2 text-base aria-[invalid=true]:border-red-700"
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {errorId ? (
        <ul id={errorId} className="text-sm text-red-700">
          {errors!.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
