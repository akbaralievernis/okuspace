import { timingSafeEqual } from 'node:crypto';

/** Секрет из заголовка `Authorization: Bearer <secret>`: сравнение за постоянное время, минимум 32 символа. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), secret);
}

export function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
