import { headers } from 'next/headers';
import { defaultLocale, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

export default async function NotFound() {
  // not-found не получает params; берём локаль из cookie, выставленной proxy.
  const cookie = (await headers()).get('cookie') ?? '';
  const match = /(?:^|;\s*)NEXT_LOCALE=([^;]+)/.exec(cookie)?.[1];
  const t = getDictionary(isLocale(match) ? match : defaultLocale);

  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-16">
      <h1 className="text-3xl font-bold">{t.notFound.heading}</h1>
    </main>
  );
}
