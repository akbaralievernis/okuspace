import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { addBlockAction, deleteBlockAction, saveAssessmentAction, saveLessonAction, saveModuleAction } from '@/server/lms/actions';
import { BLOCK_TYPES } from '@/server/lms/schemas';
import { createUserClient } from '@/server/supabase/server';

type Row = Record<string, unknown>;

export default async function CourseContentPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/courses/${id}`);
  const t = getDictionary(locale);
  const c = t.lms.courses;
  const msg = authMessages(t);
  const db = await createUserClient();

  const { data: editable } = await db.rpc('my_editable_courses');
  const course = ((editable ?? []) as { id: string; title: string }[]).find((x) => x.id === id);
  if (!course) notFound(); // нет права редактировать — как будто курса нет

  const { data: courseRow } = await db.from('courses').select('organization_id').eq('id', id).single();
  const org = courseRow?.organization_id as string;
  const [modules, lessons, blocks, assessments, questions] = await Promise.all([
    db.from('course_modules').select('id, title, position, status').eq('course_id', id).order('position'),
    db.from('lessons').select('id, module_id, title, position, status, estimated_minutes').eq('course_id', id).order('position'),
    db.from('lesson_blocks').select('id, lesson_id, position, type, content').eq('course_id', id).order('position'),
    db.from('assessments').select('id, title, status, max_attempts, reveal_answers, lesson_id').eq('course_id', id).order('created_at'),
    db.from('assessment_questions').select('assessment_id').eq('course_id', id),
  ]);
  const hidden = (form: Record<string, string>) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organizationId" value={org} />
      <input type="hidden" name="courseId" value={id} />
      {Object.entries(form).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  const statusSelect = (value: string, prefix: string) => (
    <SelectField name="status" label={t.lms.common.status} defaultValue={value} idPrefix={prefix}>
      <option value="draft">{t.lms.common.statuses.draft}</option>
      <option value="published">{t.lms.common.statuses.published}</option>
    </SelectField>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={course.title} unavailable={!!(modules.error || lessons.error)}>
      <section aria-labelledby="modules-h" className="space-y-4">
        <h2 id="modules-h" className="text-2xl font-bold">
          {c.modulesTitle}
        </h2>
        {(modules.data ?? []).map((mod: Row) => (
          <details key={mod.id as string} className="rounded-[var(--radius-card)] border border-border p-4">
            <summary className="cursor-pointer font-semibold">
              {String(mod.position)}. {mod.title as string} <Badge tone={mod.status === 'published' ? 'success' : 'neutral'}>{t.lms.common.statuses[mod.status as 'draft']}</Badge>
            </summary>
            <ActionForm action={saveModuleAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
              {hidden({ moduleId: mod.id as string })}
              <Field name="title" label={t.lms.common.title} defaultValue={mod.title as string} idPrefix={`m-${mod.id as string}`} />
              <Field name="position" type="number" label={t.lms.common.position} defaultValue={String(mod.position)} idPrefix={`m-${mod.id as string}`} />
              {statusSelect(mod.status as string, `m-${mod.id as string}`)}
            </ActionForm>

            <h3 className="mt-6 text-lg font-semibold">{c.lessonsTitle}</h3>
            {(lessons.data ?? []).filter((l: Row) => l.module_id === mod.id).map((lesson: Row) => (
              <details key={lesson.id as string} className="mt-3 rounded-[var(--radius-control)] border border-border p-3">
                <summary className="cursor-pointer font-medium">
                  {String(lesson.position)}. {lesson.title as string}{' '}
                  <Badge tone={lesson.status === 'published' ? 'success' : 'neutral'}>{t.lms.common.statuses[lesson.status as 'draft']}</Badge>
                </summary>
                <ActionForm action={saveLessonAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
                  {hidden({ moduleId: mod.id as string, lessonId: lesson.id as string })}
                  <Field name="title" label={t.lms.common.title} defaultValue={lesson.title as string} idPrefix={`l-${lesson.id as string}`} />
                  <Field name="position" type="number" label={t.lms.common.position} defaultValue={String(lesson.position)} idPrefix={`l-${lesson.id as string}`} />
                  <Field name="estimatedMinutes" type="number" label={c.estimatedMinutes} defaultValue={(lesson.estimated_minutes as number | null) ?? ''} idPrefix={`l-${lesson.id as string}`} />
                  {statusSelect(lesson.status as string, `l-${lesson.id as string}`)}
                </ActionForm>

                <h4 className="mt-4 font-semibold">{c.blocksTitle}</h4>
                <ul className="mt-2 space-y-2">
                  {(blocks.data ?? []).filter((b: Row) => b.lesson_id === lesson.id).map((b: Row) => (
                    <li key={b.id as string} className="flex flex-wrap items-start justify-between gap-2 rounded-[var(--radius-control)] bg-surface-muted px-3 py-2 text-sm">
                      <span>
                        <Badge>{c.blockTypes[b.type as 'text']}</Badge>{' '}
                        {String((b.content as Row).body ?? (b.content as Row).url ?? `${((b.content as Row).items as unknown[] | undefined)?.length ?? 0} × ${t.lms.learn.vocabulary}`).slice(0, 120)}
                      </span>
                      <ActionForm
                        action={deleteBlockAction}
                        submitLabel={c.deleteBlock}
                        pendingLabel={t.common.pending}
                        messages={msg}
                        variant="danger"
                        className="flex items-center gap-2"
                        confirm={{ title: c.deleteBlock, text: '', confirmLabel: t.lms.common.delete, cancelLabel: t.admin.common.cancel }}
                      >
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="blockId" value={b.id as string} />
                      </ActionForm>
                    </li>
                  ))}
                </ul>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium">{c.addBlock}</summary>
                  <ActionForm action={addBlockAction} submitLabel={c.addBlock} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ body: c.body, url: c.url, vocabulary: c.vocabulary }} className="mt-3 space-y-3">
                    {hidden({ lessonId: lesson.id as string })}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <SelectField name="type" label={c.blockType} idPrefix={`b-${lesson.id as string}`}>
                        {BLOCK_TYPES.map((bt) => (
                          <option key={bt} value={bt}>
                            {c.blockTypes[bt]}
                          </option>
                        ))}
                      </SelectField>
                      <Field
                        name="position"
                        type="number"
                        label={t.lms.common.position}
                        defaultValue={(blocks.data ?? []).filter((b: Row) => b.lesson_id === lesson.id).length + 1}
                        idPrefix={`b-${lesson.id as string}`}
                      />
                    </div>
                    <TextareaField name="body" label={c.body} rows={5} idPrefix={`b-${lesson.id as string}`} />
                    <Field name="url" type="url" label={c.url} idPrefix={`b-${lesson.id as string}`} />
                    <TextareaField name="vocabulary" label={c.vocabulary} rows={4} idPrefix={`b-${lesson.id as string}`} />
                  </ActionForm>
                </details>
              </details>
            ))}
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">{c.newLesson}</summary>
              <ActionForm action={saveLessonAction} submitLabel={t.lms.common.create} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: t.lms.common.title }} className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
                {hidden({ moduleId: mod.id as string, lessonId: '' })}
                <Field name="title" label={t.lms.common.title} required idPrefix={`nl-${mod.id as string}`} />
                <Field name="position" type="number" label={t.lms.common.position} defaultValue={(lessons.data ?? []).filter((l: Row) => l.module_id === mod.id).length + 1} idPrefix={`nl-${mod.id as string}`} />
                <Field name="estimatedMinutes" type="number" label={c.estimatedMinutes} idPrefix={`nl-${mod.id as string}`} />
                {statusSelect('draft', `nl-${mod.id as string}`)}
              </ActionForm>
            </details>
          </details>
        ))}
        <details className="rounded-[var(--radius-card)] border border-border p-4">
          <summary className="cursor-pointer font-medium">{c.newModule}</summary>
          <ActionForm action={saveModuleAction} submitLabel={t.lms.common.create} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: t.lms.common.title }} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
            {hidden({ moduleId: '' })}
            <Field name="title" label={t.lms.common.title} required idPrefix="nm" />
            <Field name="position" type="number" label={t.lms.common.position} defaultValue={(modules.data ?? []).length + 1} idPrefix="nm" />
            {statusSelect('draft', 'nm')}
          </ActionForm>
        </details>
      </section>

      <section aria-labelledby="tests-h" className="space-y-4">
        <h2 id="tests-h" className="text-2xl font-bold">
          {c.assessmentsTitle}
        </h2>
        <ul className="space-y-2">
          {(assessments.data ?? []).map((a: Row) => (
            <li key={a.id as string} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2">
              <span>
                {a.title as string} <Badge tone={a.status === 'published' ? 'success' : 'neutral'}>{t.lms.common.statuses[a.status as 'draft']}</Badge>{' '}
                <span className="text-sm text-muted">{fmt(c.questionsCount, { count: (questions.data ?? []).filter((q) => q.assessment_id === a.id).length })}</span>
              </span>
              <Link className="link" href={`/${locale}/app/courses/${id}/tests/${a.id as string}`}>
                {c.editQuestions}
              </Link>
            </li>
          ))}
        </ul>
        <details className="rounded-[var(--radius-card)] border border-border p-4">
          <summary className="cursor-pointer font-medium">{c.newAssessment}</summary>
          <ActionForm action={saveAssessmentAction} submitLabel={t.lms.common.create} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: t.lms.common.title }} className="mt-3 grid gap-3 sm:grid-cols-2">
            {hidden({ assessmentId: '' })}
            <Field name="title" label={t.lms.common.title} required idPrefix="na" />
            <SelectField name="lessonId" label={c.lesson} idPrefix="na">
              <option value="">{c.noLesson}</option>
              {(lessons.data ?? []).map((l: Row) => (
                <option key={l.id as string} value={l.id as string}>
                  {l.title as string}
                </option>
              ))}
            </SelectField>
            <Field name="maxAttempts" type="number" min={1} max={20} label={c.maxAttempts} defaultValue={1} idPrefix="na" />
            <SelectField name="revealAnswers" label={c.reveal} defaultValue="after_due" idPrefix="na">
              {(['after_due', 'after_submit', 'never'] as const).map((r) => (
                <option key={r} value={r}>
                  {c.reveals[r]}
                </option>
              ))}
            </SelectField>
            <TextareaField name="instructions" label={t.lms.common.description} rows={3} idPrefix="na" />
            <SelectField name="status" label={t.lms.common.status} defaultValue="draft" idPrefix="na">
              <option value="draft">{t.lms.common.statuses.draft}</option>
              <option value="published">{t.lms.common.statuses.published}</option>
            </SelectField>
          </ActionForm>
        </details>
      </section>
    </WorkspacePage>
  );
}
