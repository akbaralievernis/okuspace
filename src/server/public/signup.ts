import { z } from 'zod';
import type { Locale } from '@/i18n/config';
import { fieldErrors } from '@/lib/auth/schemas';
import type { Logger } from '@/lib/logger';
import type { RateLimiter } from '@/server/auth/ports';
import type { FormState } from '@/server/auth/use-cases';
import { leadDedupeKey } from './leads';

/**
 * Заявка «на курс» с главной страницы: для ребёнка или для себя, курс, один или несколько
 * филиалов, «откуда узнали». Сохраняется в БД (CRM), затем — если настроено — копия уходит
 * в Telegram-бот школы. Сбой пересылки не влияет на ответ человеку: заявка уже в CRM.
 */
export const HEARD_FROM = ['whatsapp', 'instagram', 'ads', 'relatives', 'other'] as const;
export type HeardFrom = (typeof HEARD_FROM)[number];

const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Телефон КР: +996 и 9 цифр; местный 0XXX XXX XXX приводится к +996. */
export function normalizeKgPhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, '');
  if (/^\+996\d{9}$/.test(digits)) return digits;
  if (/^996\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+996${digits.slice(1)}`;
  return null;
}

export const SignupSchema = z
  .object({
    forChild: z.enum(['child', 'self']),
    clientName: z.string().trim().min(2, { message: 'name_required' }).max(120, { message: 'name_too_long' }),
    childName: z.preprocess(empty, z.string().trim().max(120, { message: 'name_too_long' }).optional()),
    childAge: z.preprocess(empty, z.coerce.number({ message: 'age_invalid' }).int({ message: 'age_invalid' }).min(2, { message: 'age_invalid' }).max(99, { message: 'age_invalid' }).optional()),
    phone: z.string().transform((v, ctx) => {
      const p = normalizeKgPhone(v);
      if (!p) ctx.addIssue({ code: 'custom', message: 'phone_invalid' });
      return p ?? '';
    }),
    courseId: z.uuid({ message: 'course_required' }),
    branchIds: z.array(z.uuid({ message: 'branches_required' })).min(1, { message: 'branches_required' }).max(10, { message: 'branches_required' }),
    heardFrom: z.enum(HEARD_FROM, { message: 'heard_required' }),
    consent: z.literal('on', { message: 'consent_required' }),
    website: z.preprocess(empty, z.string().max(200).optional()), // ловушка для ботов
  })
  .refine((v) => v.forChild === 'self' || Boolean(v.childName), { message: 'child_required', path: ['childName'], when: () => true })
  .refine((v) => v.forChild === 'self' || v.childAge !== undefined, { message: 'age_invalid', path: ['childAge'], when: () => true });

export type Signup = z.infer<typeof SignupSchema>;

/** Формат Telegram-бота школы (бот отбрасывает неизвестные поля). */
export interface BotPayload {
  clientName: string;
  childName: string;
  phone: string;
  course: string;
  source: string;
  branchIds: number[];
}

const SOURCE_LABEL: Record<HeardFrom, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  ads: 'Таргет (реклама)',
  relatives: 'Родственники / знакомые',
  other: 'Другое',
};

/** «8 лет», «2 года», «21 год». */
export function ruYears(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'год' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'года' : 'лет';
  return `${n} ${word}`;
}

export function botPayload(v: Signup, courseCode: string, branchNumbers: number[]): BotPayload {
  return {
    clientName: v.clientName,
    childName: v.forChild === 'child' ? `${v.childName} (${ruYears(v.childAge!)})` : '— (взрослый)',
    phone: v.phone,
    course: courseCode,
    source: SOURCE_LABEL[v.heardFrom],
    branchIds: branchNumbers,
  };
}

export type SignupStoreResult =
  | { result: 'ok'; courseCode: string; branchNumbers: number[]; duplicate: boolean }
  | { result: 'stale_consent' | 'invalid' | 'unavailable' };

export interface SignupDeps {
  store: { submit(input: Signup & { orgSlug: string; locale: Locale; consentVersion: string; dedupeKey: string }): Promise<SignupStoreResult> };
  limiter: RateLimiter;
  logger: Logger;
  orgSlug: string;
  privacyVersion: string | null;
  ip: string;
  /** Пересылка в Telegram-бот школы; не задана — не пересылаем. */
  forward?: ((payload: BotPayload) => Promise<void>) | undefined;
  today?: () => string;
}

const LIMITS = { ip: [5, 3600], contact: [3, 86400] } as const;

export function signupInput(form: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = Object.fromEntries(form.entries());
  raw.branchIds = form.getAll('branchIds').map(String);
  return raw;
}

export async function submitSignup(raw: Record<string, unknown>, locale: Locale, deps: SignupDeps): Promise<FormState> {
  if (!deps.privacyVersion) return { status: 'error', code: 'stale_form' };
  const parsed = SignupSchema.safeParse(raw);
  if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  if (v.website) {
    deps.logger.info('signup honeypot triggered');
    return { status: 'success', code: 'request_received' };
  }
  if (raw.consentVersion !== deps.privacyVersion) return { status: 'error', code: 'stale_form' };

  try {
    if (!(await deps.limiter.hit('lead_ip', deps.ip, ...LIMITS.ip))) return { status: 'error', code: 'rate_limited' };
    if (!(await deps.limiter.hit('lead_contact', v.phone, ...LIMITS.contact))) return { status: 'error', code: 'rate_limited' };
  } catch (error) {
    deps.logger.error('rate limiter unavailable', { error });
    return { status: 'error', code: 'unavailable' };
  }

  const day = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const stored = await deps.store.submit({
    ...v,
    orgSlug: deps.orgSlug,
    locale,
    consentVersion: deps.privacyVersion,
    dedupeKey: leadDedupeKey({ orgSlug: deps.orgSlug, kind: 'signup', courseId: v.courseId, contact: v.phone, day }),
  });
  if (stored.result !== 'ok') {
    return { status: 'error', code: stored.result === 'stale_consent' ? 'stale_form' : stored.result === 'invalid' ? 'validation' : 'unavailable' };
  }
  // Повтор той же заявки за день не пересылается второй раз.
  if (deps.forward && !stored.duplicate) {
    try {
      await deps.forward(botPayload(v, stored.courseCode, stored.branchNumbers));
    } catch (error) {
      deps.logger.error('signup forward failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { status: 'success', code: 'request_received' };
}

/** Пересылка заявки в бот школы: POST JSON, тайм-аут 5 с; адрес — серверная переменная. */
export function createForwarder(url: string | undefined, token: string | undefined, fetchImpl: typeof fetch = fetch) {
  if (!url || !/^https:\/\//.test(url)) return undefined;
  return async (payload: BotPayload) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`forward http ${res.status}`);
  };
}
