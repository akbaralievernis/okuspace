import type { Locale } from './config';
import { en } from './dictionaries/en';
import { ky } from './dictionaries/ky';
import { ru, type Dictionary } from './dictionaries/ru';

const dictionaries: Record<Locale, Dictionary> = { ky, ru, en };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Название языка на нём самом — для переключателя. */
export const localeNames: Record<Locale, string> = {
  ky: 'Кыргызча',
  ru: 'Русский',
  en: 'English',
};
