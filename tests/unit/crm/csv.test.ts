import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, csvCell, parseCsv, rowsForImport, toCsv } from '@/server/crm/csv';

describe('CSV import', () => {
  it('parses quotes, escaped quotes, commas inside quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿name,note\r\n"Иванов, Иван","Сказал ""перезвонить"""\r\n\r\nАйгуль,ok\n')).toEqual([
      ['name', 'note'],
      ['Иванов, Иван', 'Сказал "перезвонить"'],
      ['Айгуль', 'ok'],
    ]);
  });

  it('detects semicolon-separated files (Excel in ru/ky locales) and multi-line cells', () => {
    expect(parseCsv('Имя;Телефон\n"Асель\nмладшая";0555 000 111')).toEqual([
      ['Имя', 'Телефон'],
      ['Асель\nмладшая', '0555 000 111'],
    ]);
  });

  it('maps ru/ky/en headers and ignores unknown columns', () => {
    expect(rowsForImport('ФИО;Телефон;Почта;Комментарий;Лишнее\nАсель;0555 000 111;;Instagram;x\nБакыт;;b@example.test;;')).toEqual({
      rows: [
        { fullName: 'Асель', phone: '0555 000 111', note: 'Instagram' },
        { fullName: 'Бакыт', email: 'b@example.test' },
      ],
    });
  });

  it('reports files without a name column or contacts, empty files and too many rows', () => {
    expect(rowsForImport('phone\n0555')).toEqual({ rows: [], error: 'no_columns' });
    expect(rowsForImport('name,note\nA,b')).toEqual({ rows: [], error: 'no_columns' });
    expect(rowsForImport('name,phone')).toEqual({ rows: [], error: 'empty' });
    const big = 'name,phone\n' + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `n${i},0555${i}`).join('\n');
    expect(rowsForImport(big)).toEqual({ rows: [], error: 'too_many' });
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas (CSV injection)', () => {
    for (const evil of ['=HYPERLINK("http://x","click")', '+1+2', '-2+3', '@SUM(A1)', '\t=1']) {
      expect(csvCell(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('+996555123456')).toBe("'+996555123456");
    expect(csvCell('Асель')).toBe('Асель');
  });

  it('quotes separators and keeps Cyrillic readable in Excel (BOM)', () => {
    const csv = toCsv(['Имя', 'Заметка'], [['Иванов, Иван', 'a"b'], [null, 3]]);
    expect(csv).toBe('﻿Имя,Заметка\r\n"Иванов, Иван","a""b"\r\n,3\r\n');
    expect(parseCsv(csv)).toEqual([
      ['Имя', 'Заметка'],
      ['Иванов, Иван', 'a"b'],
      ['', '3'],
    ]);
  });
});
