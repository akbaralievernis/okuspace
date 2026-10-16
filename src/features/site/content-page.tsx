import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { fmt } from '@/lib/format';
import type { Loaded } from '@/server/public/site';
import type { Page } from '@/server/public/schemas';
import { formatDate } from './format';

/** Страница из public_pages: опубликованный текст, «пока пусто» или «недоступно». */
export function ContentPage({ page, fallbackTitle, emptyText, locale, t }: { page: Loaded<Page>; fallbackTitle: string; emptyText: string; locale: Locale; t: Dictionary }) {
  if (!page.ok) {
    return (
      <>
        <PageHeader title={fallbackTitle} />
        <Notice tone="warning">{t.site.unavailable}</Notice>
      </>
    );
  }
  if (!page.data) {
    return (
      <>
        <PageHeader title={fallbackTitle} />
        <EmptyState title={emptyText} />
      </>
    );
  }
  return (
    <article>
      <PageHeader title={page.data.title} />
      <RichText text={page.data.body} />
      <p className="mt-8 text-sm text-muted">{fmt(t.site.pages.updated, { date: formatDate(locale, page.data.updatedAt) })}</p>
    </article>
  );
}
