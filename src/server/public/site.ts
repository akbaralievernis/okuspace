import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';
import type { z } from 'zod';
import type { Locale } from '@/i18n/config';
import { getPublicEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getSiteConfig } from '@/server/env';
import {
  CatalogSchema,
  LegalSchema,
  LevelsSchema,
  PageSchema,
  SiteSchema,
  TeachersSchema,
  TrialSlotsSchema,
  type LegalKind,
} from './schemas';

export type Loaded<T> = { ok: true; data: T } | { ok: false };

const TIMEOUT_MS = 5000;

/** Анонимный клиент: без cookie и сессии, с тайм-аутом — сайт не «висит» при недоступной БД. */
function anonClient(): SupabaseClient {
  const env = getPublicEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }) },
  });
}

async function call<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S): Promise<Loaded<z.infer<S>>> {
  try {
    const { SITE_ORGANIZATION_SLUG } = getSiteConfig();
    const { data, error } = await anonClient().rpc(fn, { p_slug: SITE_ORGANIZATION_SLUG, ...args });
    if (error) {
      logger.warn('public rpc failed', { fn, code: error.code });
      return { ok: false };
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      logger.error('public rpc returned unexpected shape', { fn, issues: parsed.error.issues.slice(0, 3) });
      return { ok: false };
    }
    return { ok: true, data: parsed.data };
  } catch (error) {
    logger.warn('public data unavailable', { fn, error });
    return { ok: false };
  }
}

export const getSite = cache(() => call('public_site', {}, SiteSchema.nullable()));
export const getCatalog = cache(() => call('public_catalog', {}, CatalogSchema));
export const getLevels = cache(() => call('public_levels', {}, LevelsSchema));
export const getTeachers = cache(() => call('public_teachers', {}, TeachersSchema));
export const getTrialSlots = cache(() => call('public_trial_slots', {}, TrialSlotsSchema));
export const getPage = cache((page: 'about' | 'contacts' | 'faq', locale: Locale) => call('public_page', { p_page: page, p_locale: locale }, PageSchema));
export const getLegal = cache((kind: LegalKind, locale: Locale) => call('public_legal', { p_kind: kind, p_locale: locale }, LegalSchema));
