import { NextResponse, type NextRequest } from 'next/server';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { logger } from '@/lib/logger';
import { getCurrentUser } from '@/server/auth/session';
import { toCsv } from '@/server/crm/csv';
import { createUserClient } from '@/server/supabase/server';

/**
 * Выгрузка контактов CRM в CSV. Права (crm.admin + MFA), охват и журнал выгрузок —
 * в функции БД crm_export; здесь только сессия, формат и запрет кеширования.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) return new NextResponse(null, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL(`/${locale}/login?next=${encodeURIComponent(`/${locale}/app/crm`)}`, request.url));
  if (user.aal !== 'aal2') return NextResponse.redirect(new URL(`/${locale}/mfa?next=${encodeURIComponent(`/${locale}/app/crm`)}`, request.url));

  const org = request.nextUrl.searchParams.get('org') ?? '';
  const branch = request.nextUrl.searchParams.get('branch');
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(org) || (branch && !uuid.test(branch))) return new NextResponse(null, { status: 400 });

  const db = await createUserClient();
  const { data, error } = await db.rpc('crm_export', { p_org: org, p_branch: branch || null });
  if (error) {
    if (error.code !== '42501') logger.error('crm export failed', { code: error.code });
    return new NextResponse(null, { status: error.code === '42501' ? 403 : 503 });
  }
  const c = getDictionary(locale).crm;
  const rows = (data ?? []) as Record<string, string | null>[];
  const csv = toCsv(
    [c.fullName, c.phone, c.email, c.source, c.stage, c.branch, c.owner, 'created_at', 'last_activity_at'],
    rows.map((r) => [
      r.fullName,
      r.phone,
      r.email,
      c.sources[r.source as 'phone'] ?? r.source,
      c.stages[r.stage as 'new'] ?? r.stage,
      r.branch,
      r.owner,
      r.createdAt,
      r.lastActivityAt,
    ]),
  );
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="crm-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
