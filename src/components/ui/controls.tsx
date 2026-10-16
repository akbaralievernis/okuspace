import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const control =
  'block min-h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-base aria-[invalid=true]:border-danger-700';

function describedBy(id: string, hint?: string, errors?: string[]) {
  return [hint ? `${id}-hint` : null, errors?.length ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
}

function Messages({ id, hint, errors }: { id: string; hint?: string | undefined; errors?: string[] | undefined }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {errors?.length ? (
        <ul id={`${id}-error`} className="text-sm text-danger-700">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function SelectField({
  name,
  label,
  hint,
  errors,
  children,
  idPrefix = 'field',
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { name: string; label: string; hint?: string; errors?: string[] | undefined; children: ReactNode; idPrefix?: string }) {
  const id = `${idPrefix}-${name}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select id={id} name={name} className={control} aria-invalid={errors?.length ? true : undefined} aria-describedby={describedBy(id, hint, errors)} {...props}>
        {children}
      </select>
      <Messages id={id} hint={hint} errors={errors} />
    </div>
  );
}

export function TextareaField({
  name,
  label,
  hint,
  errors,
  idPrefix = 'field',
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { name: string; label: string; hint?: string; errors?: string[] | undefined; idPrefix?: string }) {
  const id = `${idPrefix}-${name}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={5}
        className={`${control} min-h-28`}
        aria-invalid={errors?.length ? true : undefined}
        aria-describedby={describedBy(id, hint, errors)}
        {...props}
      />
      <Messages id={id} hint={hint} errors={errors} />
    </div>
  );
}

export function CheckboxField({ name, label, errors, required }: { name: string; label: ReactNode; errors?: string[] | undefined; required?: boolean }) {
  const id = `field-${name}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-start gap-3 text-sm">
        <input
          id={id}
          type="checkbox"
          name={name}
          required={required}
          aria-invalid={errors?.length ? true : undefined}
          aria-describedby={errors?.length ? `${id}-error` : undefined}
          className="mt-0.5 size-5 shrink-0 accent-brand-700"
        />
        <span>{label}</span>
      </label>
      <Messages id={id} errors={errors} />
    </div>
  );
}
