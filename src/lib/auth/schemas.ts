import { z } from 'zod';
import { locales } from '@/i18n/config';

/** Коды ошибок полей. Тексты — в словарях (auth.errors.*), чтобы не зависеть от языка здесь. */
export type FieldErrorCode =
  | 'email_invalid'
  | 'password_too_short'
  | 'password_too_long'
  | 'password_same_as_email'
  | 'passwords_mismatch'
  | 'name_required'
  | 'name_too_long'
  | 'consent_required'
  | 'code_invalid'
  | 'role_invalid'
  | 'reason_required'
  | 'contact_required'
  | 'phone_invalid'
  | 'message_too_long'
  | 'slot_required'
  | 'title_required'
  | 'body_required'
  | 'body_too_short'
  | 'version_invalid'
  | 'start_invalid'
  | 'start_past'
  | 'duration_invalid'
  | 'capacity_invalid'
  | 'display_name_required'
  | 'languages_invalid'
  | 'level_code_invalid'
  | 'price_invalid'
  | 'date_invalid'
  | 'points_invalid'
  | 'choices_invalid'
  | 'correct_invalid'
  | 'accepted_invalid'
  | 'url_invalid'
  | 'vocabulary_invalid'
  | 'duplicate'
  | 'time_invalid'
  | 'weekdays_required'
  | 'place_required'
  | 'count_invalid'
  | 'status_invalid'
  | 'marks_required'
  | 'amount_invalid'
  | 'assignees_required'
  | 'audience_required';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { message: 'email_invalid' })
  .pipe(z.email({ message: 'email_invalid' }));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, { message: 'password_too_short' })
  .max(PASSWORD_MAX, { message: 'password_too_long' });

const localeSchema = z.enum(locales);

export const LoginSchema = z.object({
  email: emailSchema,
  // На входе не проверяем сложность: только наличие (политика — при регистрации).
  password: z.string().min(1, { message: 'password_too_short' }).max(PASSWORD_MAX, { message: 'password_too_long' }),
});

export const RegisterSchema = z
  .object({
    fullName: z.string().trim().min(2, { message: 'name_required' }).max(200, { message: 'name_too_long' }),
    email: emailSchema,
    password: passwordSchema,
    consent: z.literal('on', { message: 'consent_required' }),
    locale: localeSchema,
  })
  .refine((v) => v.password.toLowerCase() !== v.email, { message: 'password_same_as_email', path: ['password'] });

export const ForgotPasswordSchema = z.object({ email: emailSchema });

export const ResetPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'passwords_mismatch', path: ['confirm'] });

export const MfaCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, { message: 'code_invalid' }),
});

export const InviteSchema = z.object({
  organizationId: z.uuid(),
  branchId: z.union([z.uuid(), z.literal('')]).transform((v) => (v === '' ? null : v)),
  email: emailSchema,
  role: z.enum(['branch_manager', 'admin', 'sales_manager', 'accountant', 'teacher', 'student', 'parent'], {
    message: 'role_invalid',
  }),
});

export const MembershipStatusSchema = z.object({
  membershipId: z.uuid(),
  status: z.enum(['active', 'blocked', 'revoked']),
  reason: z.string().trim().max(500).optional().default(''),
}).refine((v) => v.status === 'active' || v.reason.length >= 3, { message: 'reason_required', path: ['reason'] });

/** Плоская карта «поле → коды ошибок» из ZodError. */
export function fieldErrors(error: z.ZodError): Record<string, FieldErrorCode[]> {
  const out: Record<string, FieldErrorCode[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    (out[key] ??= []).push(issue.message as FieldErrorCode);
  }
  return out;
}
