import { z } from 'zod';

/**
 * Схемы ответов публичных RPC (public_* в миграции 0007). Ответ БД проверяется перед
 * выводом: несовместимость схемы даёт «временно недоступно», а не падение страницы.
 * Совместимость с реальными ответами SQL-функций проверяет tests/integration/public-site.test.ts.
 */
const uuid = z.uuid();
const localeText = z.object({ ky: z.string().optional(), ru: z.string().optional(), en: z.string().optional() }).partial();

export const BranchSchema = z.object({
  id: uuid,
  name: z.string(),
  city: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string(),
  whatsapp: z.string().nullable().optional(),
  number: z.number().int().nullable().optional(),
  courseIds: z.array(uuid).optional(),
});

export const SiteSchema = z.object({
  name: z.string(),
  slug: z.string(),
  branches: z.array(BranchSchema),
  legal: z.object({ privacy: z.string().nullable(), terms: z.string().nullable(), personal_data: z.string().nullable() }),
  pages: z.array(z.enum(['about', 'contacts', 'faq'])),
  /** Содержимое главной; проверяется отдельно (SiteContentSchema), чтобы ошибка в нём не ломала сайт. */
  settings: z.unknown().optional(),
});

export const CourseSchema = z.object({
  id: uuid,
  title: z.string(),
  description: z.string().nullable(),
  format: z.enum(['online', 'offline', 'hybrid']),
  kind: z.enum(['group', 'individual']),
  durationWeeks: z.number().int().nullable(),
  lessonsPerWeek: z.number().int().nullable(),
  category: z.enum(['english', 'exams', 'languages', 'school', 'it', 'other']).nullable().optional(),
  ageNote: z.string().nullable().optional(),
  language: z.object({ code: z.string(), name: z.string() }).nullable(),
  level: z.object({ code: z.string(), title: z.string(), framework: z.enum(['cefr', 'custom']), order: z.number().int() }).nullable(),
  branchIds: z.array(uuid).optional(),
  price: z.object({ amount: z.string(), currency: z.string(), unit: z.enum(['month', 'course', 'lesson', 'hour']) }).nullable(),
  groups: z.array(
    z.object({
      branchId: uuid,
      branch: z.string(),
      city: z.string(),
      startsOn: z.string(),
      enrollment: z.enum(['open', 'waitlist']),
      freeSeats: z.number().int().nonnegative(),
    }),
  ),
});
export const CatalogSchema = z.array(CourseSchema);

export const LevelsSchema = z.array(
  z.object({
    code: z.string(),
    name: z.string(),
    levels: z.array(z.object({ code: z.string(), title: z.string(), framework: z.enum(['cefr', 'custom']) })),
  }),
);

export const TeachersSchema = z.array(z.object({ displayName: z.string(), bio: localeText, languages: z.array(z.string()) }));

export const TrialSlotsSchema = z.array(
  z.object({
    id: uuid,
    branchId: uuid,
    branch: z.string(),
    city: z.string(),
    format: z.enum(['online', 'offline']),
    startsAt: z.string(),
    endsAt: z.string(),
    timezone: z.string(),
    course: z.string().nullable(),
    freeSpots: z.number().int().positive(),
  }),
);

export const PageSchema = z.object({ title: z.string(), body: z.string(), updatedAt: z.string() }).nullable();
export const LegalSchema = z.object({ title: z.string(), body: z.string(), version: z.string(), publishedAt: z.string() }).nullable();

export type Site = z.infer<typeof SiteSchema>;
export type Course = z.infer<typeof CourseSchema>;
export type Levels = z.infer<typeof LevelsSchema>;
export type Teachers = z.infer<typeof TeachersSchema>;
export type TrialSlot = z.infer<typeof TrialSlotsSchema>[number];
export type Page = z.infer<typeof PageSchema>;
export type Legal = z.infer<typeof LegalSchema>;

export const legalKinds = ['privacy', 'terms', 'personal_data'] as const;
export type LegalKind = (typeof legalKinds)[number];
/** Адреса юридических страниц: personal_data → /legal/personal-data. */
export const legalSlug: Record<LegalKind, string> = { privacy: 'privacy', terms: 'terms', personal_data: 'personal-data' };

export interface CatalogFilters {
  language?: string | undefined;
  level?: string | undefined;
  format?: string | undefined;
  branch?: string | undefined;
  category?: string | undefined;
}

/** Фильтрация каталога (чистая функция, тестируется отдельно). */
export function filterCatalog(courses: Course[], f: CatalogFilters): Course[] {
  return courses.filter(
    (c) =>
      (!f.language || c.language?.code === f.language) &&
      (!f.level || c.level?.code === f.level) &&
      (!f.category || c.category === f.category) &&
      (!f.format || c.format === f.format || (f.format !== 'hybrid' && c.format === 'hybrid')) &&
      (!f.branch || c.groups.some((g) => g.branchId === f.branch) || (c.branchIds ?? []).includes(f.branch)),
  );
}
