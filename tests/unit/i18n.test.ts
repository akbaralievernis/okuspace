import { describe, expect, it } from 'vitest';
import { defaultLocale, isLocale, locales, negotiateLocale, switchLocaleInPath } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('dictionaries', () => {
  const reference = keyPaths(getDictionary('ru')).sort();

  it.each(locales)('%s has exactly the same keys as ru', (locale) => {
    expect(keyPaths(getDictionary(locale)).sort()).toEqual(reference);
  });

  it.each(locales)('%s has no empty strings', (locale) => {
    const flat = JSON.stringify(getDictionary(locale));
    expect(flat).not.toContain('""');
  });
});

describe('isLocale', () => {
  it('accepts supported locales only', () => {
    expect(isLocale('ky')).toBe(true);
    expect(isLocale('kg')).toBe(false); // kg — код страны, не языка
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('negotiateLocale', () => {
  it('falls back to default without header', () => {
    expect(negotiateLocale(null)).toBe(defaultLocale);
    expect(negotiateLocale('')).toBe(defaultLocale);
  });

  it('respects q-weights and region subtags', () => {
    expect(negotiateLocale('en-US,en;q=0.9')).toBe('en');
    expect(negotiateLocale('ky-KG,ru;q=0.8')).toBe('ky');
    expect(negotiateLocale('de-DE,ru;q=0.5,en;q=0.7')).toBe('en');
  });

  it('ignores unsupported and q=0 entries', () => {
    expect(negotiateLocale('de,fr;q=0.9')).toBe(defaultLocale);
    expect(negotiateLocale('en;q=0,ky;q=0.1')).toBe('ky');
  });
});

describe('switchLocaleInPath', () => {
  it('replaces the locale prefix and keeps the rest of the path', () => {
    expect(switchLocaleInPath('/ru', 'en')).toBe('/en');
    expect(switchLocaleInPath('/ru/courses/a1', 'ky')).toBe('/ky/courses/a1');
  });

  it('adds a prefix when missing', () => {
    expect(switchLocaleInPath('/', 'ru')).toBe('/ru');
    expect(switchLocaleInPath('/courses', 'en')).toBe('/en/courses');
  });
});
