'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { isLocale } from '@/i18n/config';

const texts = {
  ky: { title: 'Бир нерсе туура эмес болду', body: 'Баракты кайра жүктөп көрүңүз. Ката кайталанса, кийинчерээк кириңиз.', retry: 'Кайра аракет кылуу', code: 'Ката коду' },
  ru: { title: 'Что-то пошло не так', body: 'Попробуйте загрузить страницу снова. Если ошибка повторяется, зайдите позже.', retry: 'Попробовать снова', code: 'Код ошибки' },
  en: { title: 'Something went wrong', body: 'Please try loading the page again. If the error persists, come back later.', retry: 'Try again', code: 'Error code' },
};

/** Граница ошибок: без stack trace и внутренних сообщений — только digest для поддержки. */
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const params = useParams<{ locale: string }>();
  const t = texts[isLocale(params.locale) ? params.locale : 'ru'];
  useEffect(() => {
    console.error('page error', error.digest);
  }, [error]);
  return (
    <main id="main" className="container-page py-16">
      <h1 className="text-2xl font-bold">{t.title}</h1>
      <p className="mt-2 max-w-prose text-muted">{t.body}</p>
      {error.digest ? (
        <p className="mt-2 text-sm text-muted">
          {t.code}: <code>{error.digest}</code>
        </p>
      ) : null}
      <div className="mt-6">
        <Button onClick={reset}>{t.retry}</Button>
      </div>
    </main>
  );
}
