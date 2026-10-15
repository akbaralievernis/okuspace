import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, isLocale, negotiateLocale } from '@/i18n/config';

/** CSP со случайным nonce на каждый запрос (Next.js автоматически ставит nonce на свои скрипты). */
export function buildCsp(nonce: string, options: { dev: boolean; supabaseUrl?: string | undefined }): string {
  const connect = ["'self'", options.supabaseUrl].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    // Inline-стили нужны React/Next для style-атрибутов; скрипты при этом остаются под nonce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Путь без префикса локали → перенаправляем на выбранную локаль, сохраняя путь и query.
  const firstSegment = pathname.split('/')[1];
  if (!isLocale(firstSegment)) {
    const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
    const locale = isLocale(cookieLocale) ? cookieLocale : negotiateLocale(request.headers.get('accept-language'));
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
    url.search = search;
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === 'development',
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // Запоминаем выбранный язык, чтобы следующий заход без префикса открыл его же.
  response.cookies.set(LOCALE_COOKIE, firstSegment, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  return response;
}

export const config = {
  // Всё, кроме API, статики Next и файлов с расширением.
  matcher: ['/((?!api|_next/static|_next/image|.*\\..*).*)'],
};
