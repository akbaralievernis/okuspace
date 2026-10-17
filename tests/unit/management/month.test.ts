import { describe, expect, it } from 'vitest';
import { pctText, recentMonths, reportMonth } from '@/server/grading/month';

describe('report month', () => {
  const tz = 'Asia/Bishkek';
  it('defaults to the previous month during the first week, then the current one', () => {
    expect(reportMonth(undefined, tz, new Date('2026-10-03T06:00:00Z'))).toBe('2026-09');
    expect(reportMonth(undefined, tz, new Date('2026-10-17T06:00:00Z'))).toBe('2026-10');
    expect(reportMonth(undefined, tz, new Date('2027-01-02T06:00:00Z'))).toBe('2026-12');
  });
  it('accepts only valid months that are not in the future', () => {
    const at = new Date('2026-10-17T06:00:00Z');
    expect(reportMonth('2026-08', tz, at)).toBe('2026-08');
    expect(reportMonth('2026-11', tz, at)).toBe('2026-10');
    expect(reportMonth('2026-13', tz, at)).toBe('2026-10');
    expect(reportMonth("2026-08'--", tz, at)).toBe('2026-10');
  });
  it('lists recent months and formats percentages', () => {
    expect(recentMonths(tz, 3, new Date('2026-01-10T06:00:00Z'))).toEqual(['2026-01', '2025-12', '2025-11']);
    expect([pctText(null), pctText('73.00'), pctText(81.5)]).toEqual(['—', '73%', '81.5%']);
  });
});
