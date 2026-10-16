import { createServerClient } from '@supabase/ssr';
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
    // Медиа уроков подключаются по внешним https-ссылкам (видео/аудио не исполняют код); http запрещён.
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export async function proxy(request: NextRequest) {
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development', supabaseUrl });

  // Ответ пересоздаётся, если Supabase обновил cookie сессии (заголовки запроса тоже обновляются).
  const makeResponse = () => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set('Content-Security-Policy', csp);
    // Запоминаем выбранный язык, чтобы следующий заход без префикса открыл его же.
    res.cookies.set(LOCALE_COOKIE, firstSegment, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
    return res;
  };
  let response = makeResponse();

  // Обновление истёкшей сессии Supabase. Решения о доступе здесь НЕ принимаются —
  // только в серверном коде страниц/действий и в RLS (docs/architecture/AUTH_FLOWS.md §1).
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const hasSessionCookie = request.cookies.getAll().some((c) => c.name.startsWith('sb-'));
  if (supabaseUrl && publishableKey && hasSessionCookie) {
    const supabase = createServerClient(supabaseUrl, publishableKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = makeResponse();
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        },
      },
    });
    try {
      await supabase.auth.getUser();
    } catch {
      // Сервис Auth недоступен — страница сама обработает отсутствие сессии.
    }
  }
  return response;
}

export const config = {
  // Всё, кроме API, статики Next и файлов с расширением.
  matcher: ['/((?!api|_next/static|_next/image|.*\\..*).*)'],
};
