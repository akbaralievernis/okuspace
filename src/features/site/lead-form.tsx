'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { CheckboxField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { FormMessage, fieldMessages, type AuthMessages } from '@/components/ui/form-message';
import { SubmitButton } from '@/components/ui/submit-button';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { fmt } from '@/lib/format';
import type { FormState } from '@/server/auth/use-cases';
import { submitLeadAction } from '@/server/public/actions';

export interface SlotOption {
  id: string;
  label: string;
  freeSpots: number;
}

const idle: FormState = { status: 'idle' };

/** Форма заявки: пробный урок (с выбором времени) или вопрос. Работает и без JavaScript. */
export function LeadForm({
  kind,
  locale,
  t,
  consentVersion,
  slots = [],
  courseId,
  submitLabel,
}: {
  kind: 'trial' | 'contact';
  locale: Locale;
  t: Dictionary;
  consentVersion: string;
  slots?: SlotOption[];
  courseId?: string | undefined;
  submitLabel: string;
}) {
  const [state, action] = useActionState(submitLeadAction, idle);
  const m: AuthMessages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const l = t.site.lead;
  if (state.status === 'success') return <FormMessage state={state} messages={m} />;
  const slotErrors = fieldMessages(state, 'slotId', m);

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="consentVersion" value={consentVersion} />
      {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
      <FormMessage state={state} messages={m} />

      {kind === 'trial' ? (
        <fieldset className="space-y-2" aria-describedby={slotErrors ? 'slot-error' : undefined}>
          <legend className="text-sm font-medium">{t.site.trial.slotLegend}</legend>
          {slots.map((s) => (
            <label key={s.id} className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <input type="radio" name="slotId" value={s.id} required className="size-5 accent-brand-700" />
              <span>
                {s.label} · {fmt(t.site.trial.spots, { count: s.freeSpots })}
              </span>
            </label>
          ))}
          {slotErrors ? (
            <p id="slot-error" className="text-sm text-danger-700">
              {slotErrors.join(' ')}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <Field name="fullName" label={l.fullName} autoComplete="name" required errors={fieldMessages(state, 'fullName', m)} />
      <p className="text-sm text-muted">{l.contactHint}</p>
      <Field name="phone" type="tel" label={l.phone} autoComplete="tel" inputMode="tel" errors={fieldMessages(state, 'phone', m)} />
      <Field name="email" type="email" label={l.email} autoComplete="email" errors={fieldMessages(state, 'email', m)} />
      <TextareaField name="message" label={l.message} maxLength={2000} errors={fieldMessages(state, 'message', m)} />

      {/* Ловушка для ботов: скрыта от людей и вспомогательных технологий. */}
      <div aria-hidden="true" className="hidden">
        <label htmlFor="field-website">Website</label>
        <input id="field-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <CheckboxField
        name="consent"
        required
        errors={fieldMessages(state, 'consent', m)}
        label={
          <>
            {l.consent}{' '}
            <Link className="link" href={`/${locale}/legal/privacy`} target="_blank">
              {l.consentLink}
            </Link>
          </>
        }
      />
      <SubmitButton pendingLabel={t.common.pending}>{submitLabel}</SubmitButton>
    </form>
  );
}
