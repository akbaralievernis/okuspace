import type { NextConfig } from 'next';

// Заголовки безопасности, не зависящие от запроса. CSP с nonce выставляется в src/proxy.ts.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    // Микрофон нужен AI Language Lab (этап 7) — будет разрешён точечно для своих страниц.
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // В домашней папке пользователя лежит посторонний package-lock.json — фиксируем корень проекта явно.
  turbopack: { root: __dirname },
  async headers() {
    // Страницы с одноразовыми токенами в URL не передают адрес через Referer.
    // Более поздние правила переопределяют одноимённые заголовки предыдущих.
    const noReferrer = [{ key: 'Referrer-Policy', value: 'no-referrer' }];
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/:locale/auth/confirm', headers: noReferrer },
      { source: '/:locale/invite/:token', headers: noReferrer },
    ];
  },
};

export default nextConfig;
