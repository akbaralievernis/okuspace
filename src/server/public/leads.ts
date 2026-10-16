import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Locale } from '@/i18n/config';
import { emailSchema, fieldErrors } from '@/lib/auth/schemas';
import type { Logger } from '@/lib/logger';
import type { RateLimiter } from '@/server/auth/ports';
import type { FormState } from '@/server/auth/use-cases';

/** Заявка с сайта (пробный урок или вопрос). Хранение — public.submit_lead_request (миграция 0007). */
const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
export const PHONE = /^\+?[0-9 ()-]{6,20}$/;

export const LeadSchema = z
  .object({
    kind: z.enum(['trial', 'contact']),
    fullName: z.string().trim().min(2, { message: 'name_required' }).max(120, { message: 'name_too_long' }),
    phone: z.preprocess(empty, z.string().trim().regex(PHONE, { message: 'phone_invalid' }).optional()),
    email: z.preprocess(empty, emailSchema.optional()),
    message: z.preprocess(empty, z.string().trim().max(2000, { message: 'message_too_long' }).optional()),
    slotId: z.preprocess(empty, z.uuid({ message: 'slot_required' }).optional()),
    courseId: z.preprocess(empty, z.uuid().optional()),
    branchId: z.preprocess(empty, z.uuid().optional()),
    consent: z.literal('on', { message: 'consent_required' }),
    // Поле-ловушка для ботов: скрыто от людей, должно остаться пустым.
    website: z.preprocess(empty, z.string().max(200).optional()),
  })
  // when: проверки выполняются и при ошибках в других полях — пользователь видит все ошибки сразу.
  .refine((v) => v.phone || v.email, { message: 'contact_required', path: ['phone'], when: () => true })
  .refine((v) => v.kind !== 'trial' || v.slotId, { message: 'slot_required', path: ['slotId'], when: () => true });

export type LeadResult = 'ok' | 'slot_full' | 'slot_unavailable' | 'stale_consent' | 'invalid' | 'unavailable';

export interface LeadStore {
  submit(input: {
    orgSlug: string;
    kind: 'trial' | 'contact';
    branchId: string | null;
    fullName: string;
    phone: string | null;
    email: string | null;
    message: string | null;
    courseId: string | null;
    slotId: string | null;
    locale: Locale;
    consentVersion: string;
    dedupeKey: string;
  }): Promise<LeadResult>;
}

export interface LeadDeps {
  store: LeadStore;
  limiter: RateLimiter;
  logger: Logger;
  orgSlug: string;
  /** Актуальная опубликованная версия политики конфиденциальности; null — приём заявок закрыт. */
  privacyVersion: string | null;
  ip: string;
  today?: () => string;
}

/** Повторная отправка той же заявки в тот же день даёт тот же ключ → та же запись в БД. */
export function leadDedupeKey(parts: { orgSlug: string; kind: string; slotId?: string | undefined; courseId?: string | undefined; contact: string; day: string }): string {
  const material = [parts.orgSlug, parts.kind, parts.slotId ?? '', parts.courseId ?? '', parts.contact, parts.day].join('\u0000');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

const LIMITS = { ip: [5, 3600], contact: [3, 86400] } as const;

export async function submitLead(form: FormData | Record<string, unknown>, locale: Locale, deps: LeadDeps): Promise<FormState> {
  if (!deps.privacyVersion) return { status: 'error', code: 'stale_form' };
  const raw = form instanceof FormData ? Object.fromEntries(form.entries()) : form;
  const parsed = LeadSchema.safeParse(raw);
  if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;

  // Бот заполнил ловушку: отвечаем как обычно, но ничего не сохраняем.
  if (v.website) {
    deps.logger.info('lead honeypot triggered');
    return { status: 'success', code: 'request_received' };
  }

  // Форма отправлена со страницы, загруженной до публикации новой редакции политики.
  if (raw.consentVersion !== deps.privacyVersion) return { status: 'error', code: 'stale_form' };

  const contact = (v.phone ?? '').replace(/[^\d+]/g, '') || (v.email ?? '');
  try {
    if (!(await deps.limiter.hit('lead_ip', deps.ip, ...LIMITS.ip))) return { status: 'error', code: 'rate_limited' };
    if (!(await deps.limiter.hit('lead_contact', contact, ...LIMITS.contact))) return { status: 'error', code: 'rate_limited' };
  } catch (error) {
    deps.logger.error('rate limiter unavailable', { error });
    return { status: 'error', code: 'unavailable' };
  }

  const day = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const result = await deps.store.submit({
    orgSlug: deps.orgSlug,
    kind: v.kind,
    branchId: v.branchId ?? null,
    fullName: v.fullName,
    phone: v.phone ?? null,
    email: v.email ?? null,
    message: v.message ?? null,
    courseId: v.courseId ?? null,
    slotId: v.kind === 'trial' ? (v.slotId ?? null) : null,
    locale,
    consentVersion: deps.privacyVersion,
    dedupeKey: leadDedupeKey({ orgSlug: deps.orgSlug, kind: v.kind, slotId: v.slotId, courseId: v.courseId, contact, day }),
  });

  switch (result) {
    case 'ok':
      return { status: 'success', code: 'request_received' };
    case 'slot_full':
      return { status: 'error', code: 'slot_full' };
    case 'slot_unavailable':
      return { status: 'error', code: 'slot_unavailable' };
    case 'stale_consent':
      return { status: 'error', code: 'stale_form' };
    case 'unavailable':
      return { status: 'error', code: 'unavailable' };
    default:
      return { status: 'error', code: 'validation' };
  }
}
