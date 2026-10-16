/**
 * Минимизация персональных данных перед отправкой текста внешнему AI-провайдеру.
 * Убираем то, что распознаётся надёжно: email, телефоны, ссылки, номера карт и документов.
 * Имена в свободном тексте автоматически не распознать — поэтому интерфейс предупреждает
 * не писать персональные данные, а системный промпт не содержит имён и id пользователей.
 */
const PATTERNS: [RegExp, string][] = [
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '[email]'],
  [/\bhttps?:\/\/\S+/gi, '[link]'],
  // Номера карт: 13–19 цифр с пробелами или дефисами.
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
];

// Телефоны: +996 700 123 456, (0555) 12-34-56, 0700123456. Не меньше 9 цифр — даты и годы не трогаем.
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().-]{6,}\d/g;

export function redactPersonalData(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out.replace(PHONE_CANDIDATE, (m) => ((m.match(/\d/g) ?? []).length >= 9 ? '[phone]' : m));
}

/** Нормализация ввода: пробелы, управляющие символы. Длину проверяет вызывающий. */
export function cleanInput(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n/g, '\n').trim();
}
