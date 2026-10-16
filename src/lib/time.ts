/**
 * Перевод «локальное время филиала» (значение <input type="datetime-local">) в момент UTC.
 * Без сторонних библиотек: смещение пояса берётся из Intl для конкретной даты (учитывает DST).
 */
function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs;
}

/** '2026-10-20T10:00' в поясе 'Asia/Bishkek' → Date (2026-10-20T04:00Z). null — неверный ввод или пояс. */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  try {
    let utc = naive - offsetMs(naive, timeZone);
    utc = naive - offsetMs(utc, timeZone); // второй проход — на случай перехода DST
    const result = new Date(utc);
    return Number.isNaN(result.getTime()) ? null : result;
  } catch {
    return null;
  }
}

/** Пояс по умолчанию, если у филиала он не указан (все текущие филиалы — в Кыргызстане). */
export const DEFAULT_TIMEZONE = 'Asia/Bishkek';
