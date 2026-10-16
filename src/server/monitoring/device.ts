import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Протокол устройства мониторинга (ADR-0012). Устройство (или шлюз камеры в сети школы)
 * присылает только числа: сколько людей в аудитории или факт входа/выхода.
 * Изображения, видео и любые другие поля отклоняются — схема строгая.
 * Авторизация: `Authorization: Bearer <deviceId>.<token>`; в БД хранится SHA-256 токена.
 */
export const MAX_INGEST_BYTES = 2048;

export const ReadingSchema = z.strictObject({
  kind: z.enum(['occupancy', 'in', 'out']),
  count: z.number().int().min(0).max(500).optional(),
  observedAt: z.iso.datetime({ offset: true }),
}).refine((r) => (r.kind === 'occupancy') === (r.count !== undefined), { message: 'count is required for occupancy only' });
export type Reading = z.infer<typeof ReadingSchema>;

export function parseDeviceAuth(header: string | null): { deviceId: string; token: string } | null {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,128})$/i.exec(header?.trim() ?? '');
  return m ? { deviceId: m[1]!.toLowerCase(), token: m[2]! } : null;
}

export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Новый секрет устройства: 32 случайных байта; показывается один раз. */
export function newDeviceToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}
