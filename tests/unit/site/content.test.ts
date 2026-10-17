import { describe, expect, it } from 'vitest';
import { mapLinks, parseSiteContent, pick, waLink } from '@/server/public/content';

describe('site content', () => {
  it('keeps valid sections and drops invalid ones instead of failing', () => {
    const c = parseSiteContent({
      hero: { lines: [{ ru: 'Английский,' }, { ru: 'который открывает' }], accentLine: 1, subtitle: { ru: 'Текст' } },
      stats: [{ value: '5', label: { ru: 'филиалов' } }],
      promos: 'not an array',
      logo: 'https://evil.example/logo.png',
      social: { instagram: [{ handle: '@americandream.osh', url: 'https://www.instagram.com/americandream.osh/' }], whatsapp: '+996990555504' },
      unknown: 1,
    });
    expect(c.hero?.lines).toHaveLength(2);
    expect(c.stats?.[0]?.value).toBe('5');
    expect(c.promos).toBeUndefined();
    expect(c.logo).toBeUndefined(); // только локальные файлы /brand/
    expect(c.social?.whatsapp).toBe('+996990555504');
    expect(parseSiteContent(null)).toEqual({});
    expect(parseSiteContent({ social: { instagram: [{ handle: '@x', url: 'https://evil.example/' }] } }).social).toBeUndefined();
  });

  it('picks the page language with a sensible fallback', () => {
    expect(pick({ ru: 'Привет', en: 'Hi' }, 'en')).toBe('Hi');
    expect(pick({ ru: 'Привет', en: 'Hi' }, 'ky')).toBe('Привет');
    expect(pick({ en: 'Hi' }, 'ky')).toBe('Hi');
    expect(pick(undefined, 'ru')).toBe('');
  });

  it('builds WhatsApp and map links safely', () => {
    expect(waLink('+996 990 555 504')).toBe('https://wa.me/996990555504');
    expect(waLink('+996990555504', 'Здравствуйте & ?')).toBe('https://wa.me/996990555504?text=%D0%97%D0%B4%D1%80%D0%B0%D0%B2%D1%81%D1%82%D0%B2%D1%83%D0%B9%D1%82%D0%B5%20%26%20%3F');
    const m = mapLinks('ул. Атабаева 21', 'Ош');
    expect(m.google).toBe('https://www.google.com/maps/search/?api=1&query=%D1%83%D0%BB.%20%D0%90%D1%82%D0%B0%D0%B1%D0%B0%D0%B5%D0%B2%D0%B0%2021%2C%20%D0%9E%D1%88');
    expect(m.twoGis.startsWith('https://2gis.kg/search/')).toBe(true);
  });
});
