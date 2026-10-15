import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Проверка доступности для мониторинга. Не раскрывает конфигурацию и секреты. */
export function GET() {
  return NextResponse.json(
    { status: 'ok', time: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
