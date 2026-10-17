import { describe, expect, it } from 'vitest';
import { isOverdue, localDate, parsePeriodQuery, presetPeriod } from '@/server/management/period';

describe('dashboard period', () => {
  it('uses the school time zone for "today"', () => {
    const lateUtc = new Date('2026-10-17T20:30:00Z'); // в Бишкеке (UTC+6) уже 18 октября
    expect(localDate('Asia/Bishkek', lateUtc)).toBe('2026-10-18');
    expect(localDate('UTC', lateUtc)).toBe('2026-10-17');
  });

  it('presets are inclusive and end today', () => {
    const p7 = presetPeriod('p7', 'Asia/Bishkek');
    const p30 = presetPeriod('p30', 'Asia/Bishkek');
    const month = presetPeriod('pMonth', 'Asia/Bishkek');
    const days = (p: { from: string; to: string }) => (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 + 1;
    expect(days(p7)).toBe(7);
    expect(days(p30)).toBe(30);
    expect(month.from.endsWith('-01')).toBe(true);
    expect(p7.to).toBe(p30.to);
  });

  it('rejects malformed, reversed or too long periods', () => {
    const fallback = presetPeriod('p30', 'Asia/Bishkek');
    expect(parsePeriodQuery('2026-10-01', '2026-10-31', 'Asia/Bishkek')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(parsePeriodQuery('2026-10-31', '2026-10-01', 'Asia/Bishkek')).toEqual(fallback);
    expect(parsePeriodQuery('2024-01-01', '2026-10-01', 'Asia/Bishkek')).toEqual(fallback);
    expect(parsePeriodQuery("2026-10-01'; drop", '2026-10-31', 'Asia/Bishkek')).toEqual(fallback);
    expect(parsePeriodQuery(undefined, undefined, 'Asia/Bishkek')).toEqual(fallback);
  });
});

describe('isOverdue', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  it('only open or in-progress tasks past their due date', () => {
    expect(isOverdue('open', '2026-10-17T11:00:00Z', now)).toBe(true);
    expect(isOverdue('in_progress', '2026-10-16T00:00:00Z', now)).toBe(true);
    expect(isOverdue('submitted', '2026-10-16T00:00:00Z', now)).toBe(false);
    expect(isOverdue('done', '2026-10-16T00:00:00Z', now)).toBe(false);
    expect(isOverdue('open', '2026-10-18T00:00:00Z', now)).toBe(false);
    expect(isOverdue('open', null, now)).toBe(false);
  });
});
