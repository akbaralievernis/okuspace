import 'server-only';

import type { PostgrestError } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import type { z } from 'zod';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { fieldErrors } from '@/lib/auth/schemas';
import { logger } from '@/lib/logger';
import { getCurrentUser } from '@/server/auth/session';
import type { FormState } from '@/server/auth/use-cases';

export const saved: FormState = { status: 'success', code: 'saved' };

export function localeOf(form: FormData): Locale {
  const v = form.get('locale');
  return isLocale(v) ? v : defaultLocale;
}

export const formObject = (form: FormData) => Object.fromEntries(form.entries());

/** Разбор формы схемой Zod: ошибка → состояние формы с кодами полей. */
export function parseForm<S extends z.ZodType>(schema: S, form: FormData): { ok: true; data: z.infer<S> } | { ok: false; state: FormState } {
  const parsed = schema.safeParse(formObject(form));
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, state: { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) } };
}

/** Ошибки БД → состояние формы. Отказ RLS и «нет такой строки» неразличимы для пользователя. */
export function dbState(error: PostgrestError | null, rows?: unknown[] | null): FormState {
  if (error) {
    if (error.code === '42501') return { status: 'error', code: 'forbidden' };
    if (error.code === '23505') return { status: 'error', code: 'validation', fieldErrors: { form: ['duplicate'] } };
    if (error.code?.startsWith('23') || error.code?.startsWith('22')) return { status: 'error', code: 'validation' };
    logger.error('database write failed', { code: error.code });
    return { status: 'error', code: 'unavailable' };
  }
  if (rows && rows.length === 0) return { status: 'error', code: 'forbidden' };
  return saved;
}

/**
 * Обёртка Server Action: сессия, требование MFA (задаёт действие, не форма), сброс кеша страниц.
 */
export async function runAction(
  form: FormData,
  paths: string[],
  fn: (userId: string) => Promise<FormState>,
  opts: { mfa: boolean },
): Promise<FormState> {
  try {
    const user = await getCurrentUser();
    if (!user) return { status: 'error', code: 'session_expired' };
    if (opts.mfa && user.aal !== 'aal2') return { status: 'error', code: 'mfa_required' };
    const state = await fn(user.id);
    if (state.status === 'success') for (const p of paths) revalidatePath(`/${localeOf(form)}${p}`, 'layout');
    return state;
  } catch (error) {
    unstable_rethrow(error);
    logger.error('action failed', { error });
    return { status: 'error', code: 'unavailable' };
  }
}
