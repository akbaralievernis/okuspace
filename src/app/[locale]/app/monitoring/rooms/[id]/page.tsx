import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Notice } from '@/components/ui/notice';
import { WorkspacePage } from '@/features/admin/workspace-page';
import { formatShortDateTime } from '@/features/site/format';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DEFAULT_TIMEZONE } from '@/lib/time';
import { requireAccess } from '@/server/auth/session';
import { createUserClient } from '@/server/supabase/server';

type Timeline = { snapshots: { at: string; count: number; sessionId: string | null }[]; crossings: { at: string; direction: 'in' | 'out' }[] };

/** Показания аудитории за сутки. Каждое открытие страницы пишется в журнал доступа (функция БД). */
export default async function RoomPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/monitoring/rooms/${id}`);
  const t = getDictionary(locale);
  const mt = t.monitoring;
  const db = await createUserClient();
  const { data: room } = await db.from('classrooms').select('name').eq('id', id).maybeSingle();
  if (!room) notFound();
  const to = new Date();
  const from = new Date(to.getTime() - 86_400_000);
  const { data, error } = await db.rpc('monitoring_room_timeline', { p_classroom: id, p_from: from.toISOString(), p_to: to.toISOString() });
  const timeline = data as Timeline | null;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={`${mt.classroom} ${room.name as string}`} allowed={!error || error.code !== '42501'} unavailable={Boolean(error) && error?.code !== '42501'}>
      <p>
        <Link className="link" href={`/${locale}/app/monitoring`}>
          {mt.title}
        </Link>
      </p>
      <Notice tone="info">{mt.accessLogged}</Notice>
      <section aria-labelledby="tl-h" className="space-y-2">
        <h2 id="tl-h" className="text-xl font-bold">
          {mt.roomTimeline}
        </h2>
        <ul className="space-y-1 text-sm tabular-nums">
          {(timeline?.snapshots ?? []).map((s) => (
            <li key={s.at}>
              {formatShortDateTime(locale, s.at, DEFAULT_TIMEZONE)} · {mt.people}: {s.count}
              {s.sessionId ? (
                <>
                  {' · '}
                  <Link className="link" href={`/${locale}/app/schedule/sessions/${s.sessionId}`}>
                    {mt.openSession}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        <h3 className="text-lg font-semibold">{mt.crossings}</h3>
        <ul className="space-y-1 text-sm tabular-nums">
          {(timeline?.crossings ?? []).map((c, i) => (
            <li key={`${c.at}-${i}`}>
              {formatShortDateTime(locale, c.at, DEFAULT_TIMEZONE)} · {mt.direction[c.direction]}
            </li>
          ))}
        </ul>
      </section>
    </WorkspacePage>
  );
}
