import type { ReactNode } from 'react';
import { AppHeader, appNav } from '@/components/app-header';
import { Notice, PageHeader } from '@/components/ui/notice';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import type { AccessContext } from '@/server/auth/session';

/** Каркас страницы кабинета: шапка с меню по правам, заголовок, содержимое или «нет прав». */
export function WorkspacePage({
  ctx,
  locale,
  t,
  title,
  lead,
  allowed = true,
  unavailable = false,
  children,
}: {
  ctx: AccessContext;
  locale: Locale;
  t: Dictionary;
  title: string;
  lead?: string;
  allowed?: boolean;
  unavailable?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="container-page space-y-10 py-8">
        <PageHeader title={title} lead={lead} />
        {!allowed ? <p>{t.lms.common.noRights}</p> : unavailable ? <Notice tone="warning">{t.auth.errors.unavailable}</Notice> : children}
      </main>
    </>
  );
}

export const authMessages = (t: Dictionary) => ({ errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success });
