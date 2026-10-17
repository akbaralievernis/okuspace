import { localDate } from '@/server/management/period';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Месяц табеля (YYYY-MM): из адреса, если он не позже текущего; иначе в первую неделю
 * месяца — прошлый (итоги как раз подводятся), потом — текущий.
 */
export function reportMonth(param: string | undefined, timeZone: string, at: Date = new Date()): string {
  const today = localDate(timeZone, at);
  const current = today.slice(0, 7);
  if (param && MONTH.test(param) && param <= current) return param;
  if (Number(today.slice(8, 10)) > 7) return current;
  const [y, m] = current.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Последние n месяцев (включая текущий) для выбора. */
export function recentMonths(timeZone: string, n = 12, at: Date = new Date()): string[] {
  const [y, m] = localDate(timeZone, at).slice(0, 7).split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

export const pctText = (v: unknown) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`);
