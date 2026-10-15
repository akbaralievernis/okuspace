import { isLocale, type Locale } from '@/i18n/config';

/**
 * Возвращает безопасный путь для перенаправления после входа: только относительный
 * путь внутри приложения с префиксом локали. Защита от open redirect
 * (`//evil.com`, `https://…`, `/\evil`, управляющие символы).
 */
export function safeNext(next: unknown, locale: Locale): string {
  const fallback = `/${locale}/app`;
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;

  let url: URL;
  try {
    url = new URL(next, 'http://internal.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'http://internal.invalid') return fallback;

  const first = url.pathname.split('/')[1];
  if (!isLocale(first)) return fallback;
  return `${url.pathname}${url.search}`;
}
