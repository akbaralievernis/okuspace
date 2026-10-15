import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isLocale } from '@/i18n/config';
import { logger } from '@/lib/logger';
import { buildDeps } from '@/server/auth/session';
import { verifyEmailLink } from '@/server/auth/use-cases';

/**
 * Ссылки из писем Supabase Auth (подтверждение email, восстановление пароля).
 * Шаблоны писем должны вести на /{locale}/auth/confirm?token_hash=…&type=…&next=…
 * (docs/operations/SUPABASE_AUTH.md).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : defaultLocale;
  const q = request.nextUrl.searchParams;

  let target = `/${locale}/login?error=unavailable`;
  try {
    target = await verifyEmailLink({ tokenHash: q.get('token_hash'), type: q.get('type'), next: q.get('next') }, locale, await buildDeps());
  } catch (error) {
    logger.error('email link handling failed', { error });
  }
  const response = NextResponse.redirect(new URL(target, request.nextUrl.origin));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer'); // token_hash не должен утечь через Referer
  return response;
}
