import { z } from 'zod';
import { locales } from '@/i18n/config';

/** Валидация форм управления сайтом. Права и целостность окончательно проверяет БД (RLS, триггеры). */
export const SITE_PAGES = ['about', 'contacts', 'faq'] as const;
export const LEGAL_KINDS = ['privacy', 'terms', 'personal_data'] as const;

const uuid = z.uuid();

export const PageInputSchema = z.object({
  organizationId: uuid,
  slug: z.enum(SITE_PAGES),
  contentLocale: z.enum(locales),
  title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'title_required' }),
  body: z.string().trim().min(1, { message: 'body_required' }).max(50000, { message: 'body_required' }),
  status: z.enum(['draft', 'published']),
});

export const LegalDraftSchema = z.object({
  organizationId: uuid,
  kind: z.enum(LEGAL_KINDS),
  contentLocale: z.enum(locales),
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'version_invalid' }),
  title: z.string().trim().min(2, { message: 'title_required' }).max(200, { message: 'title_required' }),
  body: z.string().trim().min(100, { message: 'body_too_short' }).max(200000, { message: 'body_required' }),
});

export const DocumentIdSchema = z.object({ id: uuid });

export const LeadStatusSchema = z.object({ id: uuid, status: z.enum(['new', 'in_progress', 'done', 'spam']) });

export const TrialSlotSchema = z.object({
  organizationId: uuid,
  branchId: uuid,
  courseId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'start_invalid' }),
  durationMinutes: z.coerce.number().int().min(15, { message: 'duration_invalid' }).max(180, { message: 'duration_invalid' }),
  capacity: z.coerce.number().int().min(1, { message: 'capacity_invalid' }).max(50, { message: 'capacity_invalid' }),
  format: z.enum(['online', 'offline']),
});

export const TeacherProfileSchema = z.object({
  organizationId: uuid,
  displayName: z.string().trim().min(2, { message: 'display_name_required' }).max(120, { message: 'display_name_required' }),
  bio_ky: z.string().trim().max(3000).optional().default(''),
  bio_ru: z.string().trim().max(3000).optional().default(''),
  bio_en: z.string().trim().max(3000).optional().default(''),
  languages: z
    .string()
    .optional()
    .default('')
    .transform((s) => [...new Set(s.split(/[\s,;]+/).map((x) => x.toLowerCase()).filter(Boolean))])
    .pipe(z.array(z.string().regex(/^[a-z]{2,3}$/, { message: 'languages_invalid' })).max(10, { message: 'languages_invalid' })),
  status: z.enum(['draft', 'published']),
});
