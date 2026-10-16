/**
 * CSV для импорта и экспорта CRM без сторонних библиотек.
 * Импорт: запятая или точка с запятой, кавычки, BOM, CRLF; заголовки на ru/ky/en.
 * Экспорт: защита от формул (CSV injection) — ячейки, начинающиеся с = + - @ или
 * табуляции/перевода строки, экранируются апострофом; BOM — для корректной кириллицы в Excel.
 */
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 512 * 1024;

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS: Record<'fullName' | 'phone' | 'email' | 'note', string[]> = {
  fullName: ['fullname', 'full_name', 'name', 'имя', 'фио', 'аты', 'аты-жөнү'],
  phone: ['phone', 'телефон', 'тел', 'номер'],
  email: ['email', 'e-mail', 'почта'],
  note: ['note', 'comment', 'комментарий', 'заметка', 'эскертүү'],
};

export interface ImportRow {
  fullName: string;
  phone?: string;
  email?: string;
  note?: string;
}

/** CSV → строки импорта. Первая строка — заголовки; неизвестные колонки игнорируются. */
export function rowsForImport(text: string): { rows: ImportRow[]; error?: 'empty' | 'no_columns' | 'too_many' } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], error: 'empty' };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const col = (k: keyof typeof HEADERS) => header.findIndex((h) => HEADERS[k].includes(h));
  const idx = { fullName: col('fullName'), phone: col('phone'), email: col('email'), note: col('note') };
  if (idx.fullName < 0 || (idx.phone < 0 && idx.email < 0)) return { rows: [], error: 'no_columns' };
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { rows: [], error: 'too_many' };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  return {
    rows: body.map((r) => {
      const out: ImportRow = { fullName: get(r, idx.fullName) };
      const phone = get(r, idx.phone);
      const email = get(r, idx.email);
      const note = get(r, idx.note);
      if (phone) out.phone = phone;
      if (email) out.email = email;
      if (note) out.note = note;
      return out;
    }),
  };
}

/** Ячейка CSV: формулы нейтрализуются, кавычки экранируются. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
