'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { CheckboxField, SelectField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { FormMessage, fieldMessages, type AuthMessages } from '@/components/ui/form-message';
import { SubmitButton } from '@/components/ui/submit-button';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import type { FormState } from '@/server/auth/use-cases';
import { submitSignupAction } from '@/server/public/actions';
import { Icon } from './brand';

export interface SignupCourse {
  id: string;
  title: string;
  category: string | null;
  branchIds: string[];
}
export interface SignupBranch {
  id: string;
  name: string;
}

const idle: FormState = { status: 'idle' };
const HEARD = ['instagram', 'whatsapp', 'ads', 'relatives', 'other'] as const;

/** Маска телефона КР: +996 XXX XXX XXX (вводить можно и без маски — сервер нормализует). */
function maskPhone(v: string): string {
  let d = v.replace(/\D/g, '');
  if (d.startsWith('0')) d = `996${d.slice(1)}`;
  if (!d.startsWith('996')) d = `996${d}`;
  d = d.slice(0, 12);
  const rest = d.slice(3);
  return ['+996', rest.slice(0, 3), rest.slice(3, 6), rest.slice(6, 9)].filter(Boolean).join(' ');
}

/** Заявка на курс: для ребёнка или для себя, курс, филиалы, «откуда узнали». */
export function SignupForm({
  locale,
  t,
  consentVersion,
  courses,
  branches,
  instagramUrl,
}: {
  locale: Locale;
  t: Dictionary;
  consentVersion: string;
  courses: SignupCourse[];
  branches: SignupBranch[];
  instagramUrl?: string | undefined;
}) {
  const [state, action] = useActionState(submitSignupAction, idle);
  const [who, setWho] = useState<'child' | 'self'>('child');
  const [course, setCourse] = useState('');
  const [phone, setPhone] = useState('');
  const m: AuthMessages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const f = t.site.home2.form;
  const err = (name: string) => fieldMessages(state, name, m);

  if (state.status === 'success') {
    return (
      <div role="status" className="space-y-4 rounded-[var(--radius-card)] bg-brand-50 p-6 text-center">
        <Icon name="star" className="mx-auto size-10 text-brand-700" />
        <p className="heading-caps text-2xl">{f.thanksTitle}</p>
        <p>{f.thanksText}</p>
        {instagramUrl ? (
          <a href={instagramUrl} rel="noopener noreferrer" target="_blank" className="inline-flex min-h-12 items-center gap-2 rounded-[var(--radius-control)] bg-brand-700 px-5 font-bold uppercase text-white no-underline hover:bg-brand-800">
            <Icon name="instagram" className="size-5" />
            {f.followInstagram}
          </a>
        ) : null}
      </div>
    );
  }

  const offered = courses.find((c) => c.id === course)?.branchIds ?? [];
  // Филиалы, где ведётся выбранный курс; если курс не привязан к филиалам — все.
  const shownBranches = offered.length ? branches.filter((b) => offered.includes(b.id)) : branches;
  const groups = [...new Set(courses.map((c) => c.category ?? 'other'))];
  const branchErrors = err('branchIds');

  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="consentVersion" value={consentVersion} />
      <FormMessage state={state} messages={m} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">{f.whoFor}</legend>
        <div className="grid grid-cols-2 gap-2 rounded-[var(--radius-control)] bg-surface-muted p-1">
          {(['child', 'self'] as const).map((v) => (
            <label key={v} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-[var(--radius-control)] px-3 text-sm font-bold uppercase ${who === v ? 'bg-brand-700 text-white' : 'text-ink'}`}>
              <input type="radio" name="forChild" value={v} checked={who === v} onChange={() => setWho(v)} className="sr-only" />
              {v === 'child' ? f.forChild : f.forSelf}
            </label>
          ))}
        </div>
      </fieldset>

      <Field name="clientName" label={who === 'child' ? f.parentName : f.clientName} autoComplete="name" required maxLength={120} errors={err('clientName')} idPrefix="su" />
      {who === 'child' ? (
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field name="childName" label={f.childName} required maxLength={120} errors={err('childName')} idPrefix="su" />
          <Field name="childAge" label={f.childAge} type="number" inputMode="numeric" min={2} max={99} required errors={err('childAge')} idPrefix="su" />
        </div>
      ) : null}
      <Field
        name="phone"
        type="tel"
        label={f.phone}
        hint={f.phoneHint}
        autoComplete="tel"
        inputMode="tel"
        required
        placeholder="+996 XXX XXX XXX"
        value={phone}
        onChange={(e) => setPhone(e.target.value ? maskPhone(e.target.value) : '')}
        errors={err('phone')}
        idPrefix="su"
      />
      <SelectField name="courseId" label={f.course} required value={course} onChange={(e) => setCourse(e.target.value)} errors={err('courseId')} idPrefix="su">
        <option value="">{f.chooseCourse}</option>
        {groups.map((g) => (
          <optgroup key={g} label={t.site.categories[g as keyof typeof t.site.categories] ?? g}>
            {courses
              .filter((c) => (c.category ?? 'other') === g)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
          </optgroup>
        ))}
      </SelectField>

      <fieldset className="space-y-2" aria-describedby={branchErrors ? 'su-branches-error' : undefined}>
        <legend className="text-sm font-semibold">{f.branches}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {shownBranches.map((b) => (
            <label key={b.id} className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2 text-sm">
              <input type="checkbox" name="branchIds" value={b.id} defaultChecked={shownBranches.length === 1} className="size-5 shrink-0 accent-brand-700" />
              {b.name}
            </label>
          ))}
        </div>
        {branchErrors ? (
          <p id="su-branches-error" className="text-sm text-danger-700">
            {branchErrors.join(' ')}
          </p>
        ) : null}
      </fieldset>

      <SelectField name="heardFrom" label={f.heardFrom} required defaultValue="" errors={err('heardFrom')} idPrefix="su">
        <option value="" disabled>
          —
        </option>
        {HEARD.map((h) => (
          <option key={h} value={h}>
            {f.heard[h]}
          </option>
        ))}
      </SelectField>

      {/* Ловушка для ботов: скрыта от людей и вспомогательных технологий. */}
      <div aria-hidden="true" className="hidden">
        <label htmlFor="su-website">Website</label>
        <input id="su-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <CheckboxField
        name="consent"
        required
        idPrefix="su"
        errors={err('consent')}
        label={
          <>
            {t.site.lead.consent}{' '}
            <Link className="link" href={`/${locale}/legal/privacy`} target="_blank">
              {t.site.lead.consentLink}
            </Link>
          </>
        }
      />
      <SubmitButton pendingLabel={t.common.pending} variant="cta">
        {f.submit}
      </SubmitButton>
    </form>
  );
}
