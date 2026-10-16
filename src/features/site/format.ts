import type { Locale } from '@/i18n/config';

/** Intl для кыргызского может отсутствовать в старых ICU — откатываемся на русский формат. */
function intlLocale(locale: Locale): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? locale : 'ru';
  } catch {
    return 'ru';
  }
}

/** Дата (YYYY-MM-DD) без сдвига часового пояса. */
export function formatDate(locale: Locale, isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Момент времени в часовом поясе филиала, с указанием пояса. */
export function formatDateTime(locale: Locale, iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date(iso));
}

export function formatTime(locale: Locale, iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: 'short', timeZone }).format(new Date(iso));
}

/**
 * Цена для показа. Сумма хранится как точная десятичная строка (numeric из БД);
 * Number используется только для форматирования, не для расчётов.
 */
export function formatPrice(locale: Locale, amount: string, currency: string): string {
  return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Number(amount));
}
