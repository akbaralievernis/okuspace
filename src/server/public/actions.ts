'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { defaultLocale, isLocale } from '@/i18n/config';
import { logger } from '@/lib/logger';
import { clientIp } from '@/server/auth/session';
import { createSupabaseRateLimiter } from '@/server/auth/supabase-adapters';
import type { FormState } from '@/server/auth/use-cases';
import { getSiteConfig } from '@/server/env';
import { createPrivilegedClient } from '@/server/supabase/server';
import { submitLead, type LeadResult, type LeadStore } from './leads';
import { getSite } from './site';

function supabaseLeadStore(client: SupabaseClient): LeadStore {
  return {
    async submit(i) {
      const { error } = await client.rpc('submit_lead_request', {
        p_org_slug: i.orgSlug,
        p_kind: i.kind,
        p_branch: i.branchId,
        p_full_name: i.fullName,
        p_phone: i.phone,
        p_email: i.email,
        p_message: i.message,
        p_course: i.courseId,
        p_slot: i.slotId,
        p_locale: i.locale,
        p_consent_version: i.consentVersion,
        p_dedupe_key: i.dedupeKey,
      });
      if (!error) return 'ok';
      const known: [RegExp, LeadResult][] = [
        [/trial slot is full/, 'slot_full'],
        [/trial slot not available/, 'slot_unavailable'],
        [/consent version is not current/, 'stale_consent'],
      ];
      for (const [re, result] of known) if (re.test(error.message)) return result;
      if (error.code?.startsWith('22') || error.code?.startsWith('23')) return 'invalid';
      logger.error('submit_lead_request failed', { code: error.code });
      return 'unavailable';
    },
  };
}

/** Заявка с публичного сайта: пробный урок или вопрос. */
export async function submitLeadAction(_prev: FormState, form: FormData): Promise<FormState> {
  const raw = form.get('locale');
  const locale = isLocale(raw) ? raw : defaultLocale;
  try {
    const site = await getSite();
    const privileged = createPrivilegedClient();
    return await submitLead(form, locale, {
      store: supabaseLeadStore(privileged),
      limiter: createSupabaseRateLimiter(privileged),
      logger,
      orgSlug: getSiteConfig().SITE_ORGANIZATION_SLUG,
      privacyVersion: site.ok && site.data ? site.data.legal.privacy : null,
      ip: await clientIp(),
    });
  } catch (error) {
    logger.error('lead submission failed', { error });
    return { status: 'error', code: 'unavailable' };
  }
}
