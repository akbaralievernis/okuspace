import { z } from 'zod';
import type { Locale } from '@/i18n/config';

/**
 * Содержимое главной страницы школы (public.site_settings.content). Тексты — на трёх
 * языках; чего нет, то не показывается (никаких выдуманных цифр и цен). Ошибка в
 * содержимом не ломает сайт: используются только разделы, прошедшие проверку.
 */
const text = z.string().trim().min(1).max(600);
export const LocalizedSchema = z.object({ ru: text.optional(), ky: text.optional(), en: text.optional() });
export type Localized = z.infer<typeof LocalizedSchema>;

export const ICONS = ['teacher', 'group', 'exam', 'chat', 'certificate', 'map', 'book', 'code', 'globe', 'star'] as const;

const path = z.string().regex(/^\/brand\/[a-z0-9._-]+\.(png|svg|webp|jpg)$/);
const phone = z.string().regex(/^\+[0-9]{10,15}$/);

export const SiteContentSchema = z.object({
  logo: path.optional(),
  hero: z
    .object({
      lines: z.array(LocalizedSchema).min(1).max(4),
      accentLine: z.number().int().min(0).max(3).optional(),
      subtitle: LocalizedSchema.optional(),
      badges: z.array(z.string().trim().min(1).max(16)).max(4).optional(),
      photo: path.optional(),
      photoNote: LocalizedSchema.optional(),
    })
    .optional(),
  stats: z.array(z.object({ value: z.string().trim().min(1).max(16), label: LocalizedSchema })).max(6).optional(),
  advantages: z.array(z.object({ icon: z.enum(ICONS), title: LocalizedSchema, text: LocalizedSchema.optional() })).max(8).optional(),
  results: z
    .array(z.object({ value: LocalizedSchema, caption: LocalizedSchema, name: LocalizedSchema, photo: path.optional() }))
    .max(6)
    .optional(),
  clubs: z.array(z.object({ title: LocalizedSchema, text: LocalizedSchema.optional() })).max(10).optional(),
  promos: z.array(LocalizedSchema).max(5).optional(),
  social: z
    .object({
      instagram: z.array(z.object({ handle: z.string().regex(/^@[A-Za-z0-9._]{1,30}$/), url: z.url().startsWith('https://www.instagram.com/'), note: LocalizedSchema.optional() })).max(4).optional(),
      whatsapp: phone.optional(),
    })
    .optional(),
});
export type SiteContent = z.infer<typeof SiteContentSchema>;

/** Проверка по разделам: неверный раздел отбрасывается, остальные остаются. */
export function parseSiteContent(raw: unknown): SiteContent {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(SiteContentSchema.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const r = schema.safeParse(value);
    if (r.success && r.data !== undefined) out[key] = r.data;
  }
  return out as SiteContent;
}

/** Текст на языке страницы; если перевода нет — русский, затем английский. */
export function pick(l: Localized | undefined, locale: Locale): string {
  if (!l) return '';
  return l[locale] ?? l.ru ?? l.en ?? l.ky ?? '';
}

/** Ссылка WhatsApp: только цифры номера. */
export const waLink = (phoneNumber: string, message?: string) =>
  `https://wa.me/${phoneNumber.replace(/\D/g, '')}${message ? `?text=${encodeURIComponent(message)}` : ''}`;

/** Ссылки на карты по адресу (без встраивания: не нужны сторонние скрипты и cookie). */
export const mapLinks = (address: string, city: string) => {
  const q = `${address}, ${city}`;
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    twoGis: `https://2gis.kg/search/${encodeURIComponent(q)}`,
  };
};
