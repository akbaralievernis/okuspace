import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { MAX_INGEST_BYTES, ReadingSchema, parseDeviceAuth, tokenHash } from '@/server/monitoring/device';
import { createPrivilegedClient } from '@/server/supabase/server';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = { recorded: 200, duplicate: 200, unauthorized: 401, disabled: 403, unassigned: 409, rejected: 400 };

/**
 * Приём показаний устройств мониторинга. Только числа; токен устройства проверяет БД
 * (по хешу), политика школы (выключено → ничего не сохраняется) — тоже БД.
 */
export async function POST(request: NextRequest) {
  const auth = parseDeviceAuth(request.headers.get('authorization'));
  if (!auth) return new NextResponse(null, { status: 401 });
  if (Number(request.headers.get('content-length') ?? '0') > MAX_INGEST_BYTES) return new NextResponse(null, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_INGEST_BYTES) return new NextResponse(null, { status: 413 });

  let reading;
  try {
    reading = ReadingSchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: 'invalid reading' }, { status: 400 });
  }

  let result;
  try {
    result = await createPrivilegedClient().rpc('ingest_monitoring', {
      p_device: auth.deviceId,
      p_token_sha256: tokenHash(auth.token),
      p_kind: reading.kind,
      p_people_count: reading.count ?? null,
      p_observed_at: reading.observedAt,
    });
  } catch (e) {
    // Нет серверной конфигурации или сети — устройство повторит позже.
    logger.error('monitoring ingest unavailable', { error: e instanceof Error ? e.name : String(e) });
    return new NextResponse(null, { status: 503 });
  }
  const { data, error } = result;
  if (error) {
    logger.error('monitoring ingest failed', { code: error.code });
    return new NextResponse(null, { status: 503 });
  }
  const outcome = (data as { outcome: string }).outcome;
  if (outcome === 'unauthorized') logger.warn('monitoring ingest unauthorized', { deviceId: auth.deviceId });
  return NextResponse.json({ outcome }, { status: STATUS[outcome] ?? 400, headers: { 'cache-control': 'no-store' } });
}
