import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { LessonVisit } from '@/features/lms/lesson-visit';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { trackLessonAction } from '@/server/lms/actions';
import { courseProgress } from '@/server/lms/queries';
import { createUserClient } from '@/server/supabase/server';

type Block = { id: string; type: string; content: Record<string, unknown> };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export default async function LessonPage({ params }: { params: Promise<{ locale: string; lessonId: string }> }) {
  const { locale, lessonId } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(lessonId)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/learn/lessons/${lessonId}`);
  const t = getDictionary(locale);
  const l = t.lms.learn;

  const db = await createUserClient();
  // RLS отдаёт урок ученику только если он опубликован и ученик записан в группу курса.
  const { data: lesson } = await db.from('lessons').select('id, course_id, title, estimated_minutes, status').eq('id', lessonId).maybeSingle();
  if (!lesson || lesson.status !== 'published') notFound();
  const courseId = lesson.course_id as string;
  const [{ data: blocks }, { data: course }, progress] = await Promise.all([
    db.from('lesson_blocks').select('id, type, content').eq('lesson_id', lessonId).order('position'),
    db.from('courses').select('title').eq('id', courseId).maybeSingle(),
    courseProgress(courseId),
  ]);
  const done = progress?.completedLessonIds.includes(lessonId) ?? false;
  // Следующий урок — первый незавершённый после текущего (порядок задаёт course_progress).
  const next = progress?.nextLessonId && progress.nextLessonId !== lessonId ? progress.nextLessonId : null;

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={lesson.title as string}>
      <LessonVisit lessonId={lessonId} />
      <p className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <Link className="link" href={`/${locale}/app/learn/${courseId}`}>
          {(course?.title as string | undefined) ?? l.outline}
        </Link>
        {done ? <Badge tone="success">{l.lessonCompleted}</Badge> : null}
      </p>

      <div className="space-y-6">
        {((blocks ?? []) as Block[]).map((b) => (
          <LessonBlock key={b.id} block={b} labels={l} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-6">
        {done ? null : (
          <ActionForm action={trackLessonAction} submitLabel={l.markComplete} pendingLabel={t.common.pending} messages={authMessages(t)} className="space-y-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="lessonId" value={lessonId} />
            <input type="hidden" name="completed" value="true" />
          </ActionForm>
        )}
        {next ? (
          <ButtonLink href={`/${locale}/app/learn/lessons/${next}`} variant={done ? 'primary' : 'secondary'}>
            {l.nextLesson}
          </ButtonLink>
        ) : null}
      </div>
    </WorkspacePage>
  );
}

function LessonBlock({ block, labels }: { block: Block; labels: ReturnType<typeof getDictionary>['lms']['learn'] }) {
  const c = block.content;
  switch (block.type) {
    case 'vocabulary': {
      const items = Array.isArray(c.items) ? (c.items as { term?: unknown; meaning?: unknown }[]) : [];
      return (
        <Card>
          <h2 className="mb-3 text-lg font-semibold">{labels.vocabulary}</h2>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
            {items.map((i, n) => (
              <div key={n} className="contents">
                <dt className="font-semibold">{str(i.term)}</dt>
                <dd>{str(i.meaning)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      );
    }
    case 'video':
    case 'audio':
    case 'listening': {
      const url = str(c.url);
      const transcript = str(c.transcript);
      // URL проверен в БД (только https). Без субтитров — расшифровка рядом с плеером.
      return (
        <figure className="space-y-3">
          {block.type === 'video' ? (
            <video controls preload="metadata" className="w-full rounded-[var(--radius-card)] bg-ink" src={url}>
              {labels.mediaUnsupported}
            </video>
          ) : (
            <audio controls preload="metadata" className="w-full" src={url}>
              {labels.mediaUnsupported}
            </audio>
          )}
          {transcript ? (
            <details className="rounded-[var(--radius-control)] border border-border p-3">
              <summary className="cursor-pointer font-medium">{labels.transcript}</summary>
              <div className="mt-2">
                <RichText text={transcript} />
              </div>
            </details>
          ) : null}
        </figure>
      );
    }
    default:
      return (
        <section className={block.type === 'text' || block.type === 'reading' ? '' : 'rounded-[var(--radius-card)] border-l-4 border-brand-700 bg-surface-muted p-4'}>
          <RichText text={str(c.body)} />
        </section>
      );
  }
}
