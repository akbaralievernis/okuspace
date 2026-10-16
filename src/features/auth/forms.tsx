'use client';

import Image from 'next/image';
import { useActionState, useState } from 'react';
import { Field } from '@/components/ui/field';
import { FormMessage, fieldMessages, type AuthMessages } from '@/components/ui/form-message';
import { SubmitButton } from '@/components/ui/submit-button';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import type { Locale } from '@/i18n/config';
import {
  enrollMfaAction,
  forgotPasswordAction,
  loginAction,
  registerAction,
  resetPasswordAction,
  verifyMfaAction,
} from '@/server/auth/actions';
import type { FormState } from '@/server/auth/use-cases';

const idle: FormState = { status: 'idle' };
type AuthDict = Dictionary['auth'];
interface Common {
  locale: Locale;
  t: AuthDict;
  pending: string;
}
const msgs = (t: AuthDict): AuthMessages => ({ errors: t.errors, fieldErrors: t.fieldErrors, success: t.success });

export function LoginForm({ locale, t, pending, next }: Common & { next: string }) {
  const [state, action] = useActionState(loginAction, idle);
  const m = msgs(t);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="next" value={next} />
      <FormMessage state={state} messages={m} />
      <Field name="email" type="email" label={t.email} autoComplete="email" required errors={fieldMessages(state, 'email', m)} />
      <Field name="password" type="password" label={t.password} autoComplete="current-password" required errors={fieldMessages(state, 'password', m)} />
      <SubmitButton pendingLabel={pending}>{t.loginSubmit}</SubmitButton>
    </form>
  );
}

export function RegisterForm({ locale, t, pending, documents }: Common & { documents: { href: string; label: string }[] }) {
  const [state, action] = useActionState(registerAction, idle);
  const m = msgs(t);
  if (state.status === 'success') return <FormMessage state={state} messages={m} />;
  const consentErrors = fieldMessages(state, 'consent', m);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <FormMessage state={state} messages={m} />
      <Field name="fullName" label={t.fullName} autoComplete="name" required errors={fieldMessages(state, 'fullName', m)} />
      <Field name="email" type="email" label={t.email} autoComplete="email" required errors={fieldMessages(state, 'email', m)} />
      <Field
        name="password"
        type="password"
        label={t.password}
        hint={t.passwordHint}
        autoComplete="new-password"
        minLength={10}
        required
        errors={fieldMessages(state, 'password', m)}
      />
      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="consent"
            required
            aria-invalid={consentErrors ? true : undefined}
            aria-describedby={consentErrors ? 'consent-error' : undefined}
            className="mt-1 size-5"
          />
          <span>
            {t.consent}{' '}
            {documents.map((d, i) => (
              <span key={d.href}>
                {i > 0 ? ', ' : ''}
                <a className="link" href={d.href} target="_blank" rel="noopener">
                  {d.label}
                </a>
              </span>
            ))}
          </span>
        </label>
        {consentErrors ? (
          <p id="consent-error" className="text-sm text-danger-700">
            {consentErrors.join(' ')}
          </p>
        ) : null}
      </div>
      <SubmitButton pendingLabel={pending}>{t.registerSubmit}</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm({ locale, t, pending }: Common) {
  const [state, action] = useActionState(forgotPasswordAction, idle);
  const m = msgs(t);
  if (state.status === 'success') return <FormMessage state={state} messages={m} />;
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <FormMessage state={state} messages={m} />
      <Field name="email" type="email" label={t.email} autoComplete="email" required errors={fieldMessages(state, 'email', m)} />
      <SubmitButton pendingLabel={pending}>{t.forgotSubmit}</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm({ locale, t, pending }: Common) {
  const [state, action] = useActionState(resetPasswordAction, idle);
  const m = msgs(t);
  if (state.status === 'success') return <FormMessage state={state} messages={m} />;
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <FormMessage state={state} messages={m} />
      <Field name="password" type="password" label={t.password} hint={t.passwordHint} autoComplete="new-password" required errors={fieldMessages(state, 'password', m)} />
      <Field name="confirm" type="password" label={t.confirmPassword} autoComplete="new-password" required errors={fieldMessages(state, 'confirm', m)} />
      <SubmitButton pendingLabel={pending}>{t.resetSubmit}</SubmitButton>
    </form>
  );
}

function MfaCodeForm({ locale, t, pending, factorId, next }: Common & { factorId: string; next: string }) {
  const [state, action] = useActionState(verifyMfaAction, idle);
  const m = msgs(t);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="factorId" value={factorId} />
      <input type="hidden" name="next" value={next} />
      <FormMessage state={state} messages={m} />
      <Field
        name="code"
        label={t.mfaCode}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        errors={fieldMessages(state, 'code', m)}
      />
      <SubmitButton pendingLabel={pending}>{t.mfaSubmit}</SubmitButton>
    </form>
  );
}

/** Ввод кода для уже подключённого фактора или подключение нового (QR + код). */
export function MfaPanel({ locale, t, pending, factorId, next }: Common & { factorId: string | null; next: string }) {
  const [enrolment, setEnrolment] = useState<{ factorId: string; qrCode: string; secret: string } | null>(null);
  const [error, setError] = useState<FormState>(idle);

  if (factorId) return <MfaCodeForm locale={locale} t={t} pending={pending} factorId={factorId} next={next} />;

  if (!enrolment) {
    return (
      <div className="space-y-4">
        <p>{t.mfaEnrollIntro}</p>
        <FormMessage state={error} messages={msgs(t)} />
        <button
          type="button"
          className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800"
          onClick={async () => {
            const result = await enrollMfaAction();
            if (result.ok) setEnrolment(result);
            else setError({ status: 'error', code: result.code });
          }}
        >
          {t.mfaStart}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Image src={enrolment.qrCode} alt={t.mfaQrAlt} width={192} height={192} unoptimized className="rounded border border-border bg-surface p-2" />
      <p className="text-sm">
        {t.mfaSecret}: <code className="break-all font-mono">{enrolment.secret}</code>
      </p>
      <MfaCodeForm locale={locale} t={t} pending={pending} factorId={enrolment.factorId} next={next} />
    </div>
  );
}
