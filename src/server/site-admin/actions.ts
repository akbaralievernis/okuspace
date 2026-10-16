'use server';

import type { PostgrestError } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { fieldErrors } from '@/lib/auth/schemas';
import { logger } from '@/lib/logger';
import { zonedLocalToUtc } from '@/lib/time';
import { getCurrentUser } from '@/server/auth/session';
import type { FormState } from '@/server/auth/use-cases';
import { createUserClient } from '@/server/supabase/server';
import { DocumentIdSchema, LeadStatusSchema, LegalDraftSchema, PageInputSchema, TeacherProfileSchema, TrialSlotSchema } from './schemas';

const ok: FormState = { status: 'success', code: 'saved' };
const localeOf = (form: FormData): Locale => {
  const v = form.get('locale');
  return isLocale(v) ? v : defaultLocale;
};

/** Ошибки БД → состояние формы. RLS-отказ и «нет такой строки» неразличимы для пользователя. */
function dbState(error: PostgrestError | null, rows?: unknown[] | null): FormState {
  if (error) {
    if (error.code === '42501') return { status: 'error', code: 'forbidden' };
    if (error.code?.startsWith('23') || error.code?.startsWith('22')) return { status: 'error', code: 'validation' };
    logger.error('site admin write failed', { code: error.code });
    return { status: 'error', code: 'unavailable' };
  }
  if (rows && rows.length === 0) return { status: 'error', code: 'forbidden' };
  return ok;
}

/**
 * Обёртка действий. Требование MFA задаёт само действие (а не форма — её поля контролирует клиент).
 * БД дополнительно требует aal2 для site.manage / lead.manage (миграция 0007).
 */
async function run(form: FormData, paths: string[], fn: (userId: string) => Promise<FormState>, opts: { mfa: boolean } = { mfa: true }): Promise<FormState> {
  try {
    const user = await getCurrentUser();
    if (!user) return { status: 'error', code: 'session_expired' };
    if (opts.mfa && user.aal !== 'aal2') return { status: 'error', code: 'mfa_required' };
    const state = await fn(user.id);
    if (state.status === 'success') for (const p of paths) revalidatePath(`/${localeOf(form)}${p}`);
    return state;
  } catch (error) {
    unstable_rethrow(error);
    logger.error('site admin action failed', { error });
    return { status: 'error', code: 'unavailable' };
  }
}

const data = (form: FormData) => Object.fromEntries(form.entries());

export async function savePageAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/site', '/about', '/contacts', '/faq'], async (userId) => {
    const parsed = PageInputSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
    const v = parsed.data;
    const client = await createUserClient();
    const { error } = await client.from('public_pages').upsert(
      { organization_id: v.organizationId, slug: v.slug, locale: v.contentLocale, title: v.title, body: v.body, status: v.status, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id,slug,locale' },
    );
    return dbState(error);
  });
}

export async function createLegalDraftAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/site'], async (userId) => {
    const parsed = LegalDraftSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
    const v = parsed.data;
    const client = await createUserClient();
    const { error } = await client.from('legal_documents').insert({
      organization_id: v.organizationId, kind: v.kind, locale: v.contentLocale, version: v.version, title: v.title, body: v.body, created_by: userId,
    });
    if (error?.code === '23505') return { status: 'error', code: 'validation', fieldErrors: { version: ['version_invalid'] } };
    return dbState(error);
  });
}

export async function publishLegalAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/site', '/legal', '/register'], async () => {
    const parsed = DocumentIdSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation' };
    const client = await createUserClient();
    const { data: rows, error } = await client.from('legal_documents').update({ status: 'published' }).eq('id', parsed.data.id).eq('status', 'draft').select('id');
    return dbState(error, rows);
  });
}

export async function deleteLegalDraftAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/site'], async () => {
    const parsed = DocumentIdSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation' };
    const client = await createUserClient();
    const { data: rows, error } = await client.from('legal_documents').delete().eq('id', parsed.data.id).eq('status', 'draft').select('id');
    return dbState(error, rows);
  });
}

export async function setLeadStatusAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/requests'], async (userId) => {
    const parsed = LeadStatusSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation' };
    const client = await createUserClient();
    const { data: rows, error } = await client
      .from('lead_requests')
      .update({ status: parsed.data.status, handled_by: userId })
      .eq('id', parsed.data.id)
      .select('id');
    return dbState(error, rows);
  });
}

export async function createTrialSlotAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/trials', '/trial'], async (userId) => {
    const parsed = TrialSlotSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
    const v = parsed.data;
    const client = await createUserClient();
    const { data: branch, error: branchError } = await client.from('branches').select('timezone').eq('id', v.branchId).maybeSingle();
    if (branchError || !branch) return dbState(branchError, []);
    const start = zonedLocalToUtc(v.start, branch.timezone as string);
    if (!start) return { status: 'error', code: 'validation', fieldErrors: { start: ['start_invalid'] } };
    if (start.getTime() <= Date.now()) return { status: 'error', code: 'validation', fieldErrors: { start: ['start_past'] } };
    const end = new Date(start.getTime() + v.durationMinutes * 60_000);
    const { error } = await client.from('trial_slots').insert({
      organization_id: v.organizationId,
      branch_id: v.branchId,
      course_id: v.courseId ?? null,
      period: `[${start.toISOString()},${end.toISOString()})`,
      format: v.format,
      capacity: v.capacity,
      created_by: userId,
    });
    return dbState(error);
  });
}

export async function cancelTrialSlotAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/trials', '/trial'], async () => {
    const parsed = DocumentIdSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation' };
    const client = await createUserClient();
    const { data: rows, error } = await client.from('trial_slots').update({ status: 'cancelled' }).eq('id', parsed.data.id).eq('status', 'open').select('id');
    return dbState(error, rows);
  });
}

/** Профиль преподавателя редактирует сам преподаватель; MFA для этой роли не требуется. */
export async function saveTeacherProfileAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run(form, ['/app/profile', '/teachers'], async (userId) => {
    const parsed = TeacherProfileSchema.safeParse(data(form));
    if (!parsed.success) return { status: 'error', code: 'validation', fieldErrors: fieldErrors(parsed.error) };
    const v = parsed.data;
    const bio = Object.fromEntries(
      (['ky', 'ru', 'en'] as const).map((l) => [l, v[`bio_${l}`]]).filter(([, text]) => text),
    );
    const client = await createUserClient();
    const { error } = await client.from('teacher_public_profiles').upsert(
      { organization_id: v.organizationId, profile_id: userId, display_name: v.displayName, bio, languages: v.languages, status: v.status },
      { onConflict: 'organization_id,profile_id' },
    );
    return dbState(error);
  }, { mfa: false });
}
