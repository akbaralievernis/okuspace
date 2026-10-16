import { notFound } from 'next/navigation';
import { EmptyState, Notice } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatDate } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

/** Уведомление о мониторинге аудиторий — для всех участников школы (ученики, родители, сотрудники). */
export default async function MonitoringNoticePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/monitoring/notice`);
  const t = getDictionary(locale);
  const mt = t.monitoring;
  const db = await createUserClient();
  // RLS: участник видит политику только своей школы.
  const { data: policies } = await db.from('monitoring_policies').select('organization_id, notice_text, notice_published_at, purpose, data_retention_days').not('notice_published_at', 'is', null);

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={mt.noticeTitle}>
      {(policies ?? []).length === 0 ? <EmptyState title={mt.disabled} /> : null}
      {(policies ?? []).map((p) => (
        <article key={p.organization_id as string} className="space-y-3">
          <RichText text={p.notice_text as string} />
          <p className="text-sm text-muted">
            {mt.purpose}: {p.purpose as string} · {mt.dataRetention}: {String(p.data_retention_days)} · {formatDate(locale, (p.notice_published_at as string).slice(0, 10))}
          </p>
        </article>
      ))}
      <Notice tone="info" title={mt.levelsTitle}>
        {mt.levels}
      </Notice>
    </WorkspacePage>
  );
}
