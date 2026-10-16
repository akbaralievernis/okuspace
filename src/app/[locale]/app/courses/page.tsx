import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, EmptyState } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

/** Курсы, материалы которых пользователь может редактировать (преподаватель курса или методист). */
export default async function CoursesAdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/courses`);
  const t = getDictionary(locale);
  const db = await createUserClient();
  // Только курсы, которые пользователь вправе редактировать (преподаватель курса или методист).
  const { data, error } = await db.rpc('my_editable_courses');
  const editable = (data ?? []) as { id: string; title: string; status: string }[];

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={t.lms.courses.title} unavailable={!!error}>
      {editable.length === 0 ? (
        <EmptyState title={t.lms.courses.empty} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {editable.map((c) => (
            <li key={c.id as string} className="relative rounded-[var(--radius-card)] border border-border p-4">
              <Link href={`/${locale}/app/courses/${c.id as string}`} className="font-semibold text-ink no-underline after:absolute after:inset-0 hover:underline">
                {c.title as string}
              </Link>{' '}
              <Badge tone={c.status === 'published' ? 'success' : 'neutral'}>{t.lms.common.statuses[c.status as 'draft']}</Badge>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}
