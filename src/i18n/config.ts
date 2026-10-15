export const locales = ['ky', 'ru', 'en'] as const;
export type Locale = (typeof locales)[number];

/** Локаль по умолчанию — утверждена пользователем (ADR-0003). */
export const defaultLocale: Locale = 'ru';

export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/**
 * Выбор локали по заголовку Accept-Language (RFC 9110, веса q).
 * Сравнивается основной subtag: `ru-RU` → `ru`, `ky-KG` → `ky`.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;

  const candidates = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { base: tag.toLowerCase().split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((c) => c.base !== '' && c.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { base } of candidates) {
    if (isLocale(base)) return base;
  }
  return defaultLocale;
}

/** Заменяет (или добавляет) префикс локали в пути, сохраняя остальной путь. */
export function switchLocaleInPath(pathname: string, target: Locale): string {
  const segments = pathname.split('/');
  if (isLocale(segments[1])) {
    segments[1] = target;
    return segments.join('/') || `/${target}`;
  }
  return `/${target}${pathname === '/' ? '' : pathname}`;
}
