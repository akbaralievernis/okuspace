/** Даты по часовому поясу школы (YYYY-MM-DD) для панели и сроков задач. */
export function localDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export type Preset = 'p7' | 'p30' | 'pMonth';

export function presetPeriod(preset: Preset, timeZone: string): { from: string; to: string } {
  const to = localDate(timeZone);
  if (preset === 'p7') return { from: shift(to, -6), to };
  if (preset === 'pMonth') return { from: `${to.slice(0, 8)}01`, to };
  return { from: shift(to, -29), to };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Период из адресной строки; неверный или длиннее 400 дней — 30 дней по умолчанию. */
export function parsePeriodQuery(from: string | undefined, to: string | undefined, timeZone: string): { from: string; to: string } {
  if (from && to && ISO.test(from) && ISO.test(to) && from <= to) {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (Number.isFinite(days) && days <= 400) return { from, to };
  }
  return presetPeriod('p30', timeZone);
}

/** Текущий момент для серверной отрисовки (одно значение на запрос). */
export const nowMs = () => Date.now();

/** Просрочена ли задача (срок прошёл, а она не сдана). */
export const isOverdue = (status: string, dueAt: string | null, now: number = Date.now()) =>
  Boolean(dueAt) && (status === 'open' || status === 'in_progress') && Date.parse(dueAt!) < now;
