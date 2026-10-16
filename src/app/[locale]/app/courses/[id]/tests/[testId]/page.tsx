import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Notice } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { addQuestionAction, deleteQuestionAction, saveAssessmentAction } from '@/server/lms/actions';
import { QUESTION_TYPES } from '@/server/lms/schemas';
import { createUserClient } from '@/server/supabase/server';

type Option = { id: string; text: string };

/** Конструктор теста. Ключи ответов видит только редактор курса (RLS). */
export default async function TestEditorPage({ params }: { params: Promise<{ locale: string; id: string; testId: string }> }) {
  const { locale, id, testId } = await params;
  if (!isLocale(locale) || !/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(testId)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/courses/${id}/tests/${testId}`);
  const t = getDictionary(locale);
  const c = t.lms.courses;
  const msg = authMessages(t);
  const db = await createUserClient();

  const { data: editable } = await db.rpc('my_editable_courses');
  if (!((editable ?? []) as { id: string }[]).some((x) => x.id === id)) notFound();
  const { data: test } = await db.from('assessments').select('id, organization_id, title, instructions, status, max_attempts, reveal_answers, lesson_id').eq('id', testId).eq('course_id', id).maybeSingle();
  if (!test) notFound();
  const [{ data: questions }, { data: keys }] = await Promise.all([
    db.from('assessment_questions').select('id, position, type, skill, prompt, options, points, explanation').eq('assessment_id', testId).order('position'),
    db.from('assessment_answer_keys').select('question_id, key'),
  ]);
  const keyOf = (qid: string) => (keys ?? []).find((k) => k.question_id === qid)?.key as Record<string, unknown> | undefined;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organizationId" value={test.organization_id as string} />
      <input type="hidden" name="courseId" value={id} />
      <input type="hidden" name="assessmentId" value={testId} />
    </>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={test.title as string} lead={c.keyHidden}>
      <details className="rounded-[var(--radius-card)] border border-border p-4">
        <summary className="cursor-pointer font-medium">{t.lms.common.save}</summary>
        <ActionForm action={saveAssessmentAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} className="mt-3 grid gap-3 sm:grid-cols-2">
          {hidden}
          <input type="hidden" name="lessonId" value={(test.lesson_id as string | null) ?? ''} />
          <Field name="title" label={t.lms.common.title} defaultValue={test.title as string} idPrefix="ta" />
          <Field name="maxAttempts" type="number" min={1} max={20} label={c.maxAttempts} defaultValue={String(test.max_attempts)} idPrefix="ta" />
          <SelectField name="revealAnswers" label={c.reveal} defaultValue={test.reveal_answers as string} idPrefix="ta">
            {(['after_due', 'after_submit', 'never'] as const).map((r) => (
              <option key={r} value={r}>
                {c.reveals[r]}
              </option>
            ))}
          </SelectField>
          <SelectField name="status" label={t.lms.common.status} defaultValue={test.status as string} idPrefix="ta">
            {(['draft', 'published', 'archived'] as const).map((s) => (
              <option key={s} value={s}>
                {t.lms.common.statuses[s]}
              </option>
            ))}
          </SelectField>
          <TextareaField name="instructions" label={t.lms.common.description} defaultValue={(test.instructions as string | null) ?? ''} rows={3} idPrefix="ta" />
        </ActionForm>
      </details>

      <section aria-labelledby="q-h" className="space-y-3">
        <h2 id="q-h" className="text-2xl font-bold">
          {c.questionsTitle}
        </h2>
        <ol className="space-y-3">
          {(questions ?? []).map((q) => {
            const key = keyOf(q.id as string);
            return (
              <li key={q.id as string} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
                <p>
                  <Badge>{c.questionTypes[q.type as 'short_text']}</Badge> <Badge tone="brand">{c.skills[q.skill as 'grammar']}</Badge> · {String(q.points)}
                </p>
                <p className="whitespace-pre-wrap">{q.prompt as string}</p>
                {(q.options as Option[]).length ? (
                  <ul className="list-disc pl-6 text-sm">
                    {(q.options as Option[]).map((o) => (
                      <li key={o.id}>
                        {o.id}) {o.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-sm text-muted">
                  {t.lms.learn.correctAnswer}: <code>{JSON.stringify(key ?? {})}</code>
                </p>
                <ActionForm
                  action={deleteQuestionAction}
                  submitLabel={c.deleteQuestion}
                  pendingLabel={t.common.pending}
                  messages={msg}
                  variant="danger"
                  className="flex items-center gap-2"
                  confirm={{ title: c.deleteQuestion, text: '', confirmLabel: t.lms.common.delete, cancelLabel: t.admin.common.cancel }}
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="questionId" value={q.id as string} />
                </ActionForm>
              </li>
            );
          })}
        </ol>
        {test.status === 'published' ? <Notice tone="info">{c.keyHidden}</Notice> : null}
        <details className="rounded-[var(--radius-card)] border border-border p-4" open={(questions ?? []).length === 0}>
          <summary className="cursor-pointer font-medium">{c.addQuestion}</summary>
          <ActionForm
            action={addQuestionAction}
            submitLabel={c.addQuestion}
            pendingLabel={t.common.pending}
            messages={msg}
            fieldLabels={{ prompt: c.prompt, points: c.points, choices: c.choices, accepted: c.accepted }}
            className="mt-3 space-y-3"
          >
            {hidden}
            <div className="grid gap-3 sm:grid-cols-4">
              <SelectField name="type" label={c.questionType} idPrefix="nq">
                {QUESTION_TYPES.map((qt) => (
                  <option key={qt} value={qt}>
                    {c.questionTypes[qt]}
                  </option>
                ))}
              </SelectField>
              <SelectField name="skill" label={c.skill} idPrefix="nq">
                {(['grammar', 'vocabulary', 'reading', 'listening'] as const).map((s) => (
                  <option key={s} value={s}>
                    {c.skills[s]}
                  </option>
                ))}
              </SelectField>
              <Field name="points" inputMode="decimal" label={c.points} defaultValue="1" idPrefix="nq" />
              <Field name="position" type="number" label={t.lms.common.position} defaultValue={(questions ?? []).length + 1} idPrefix="nq" />
            </div>
            <TextareaField name="prompt" label={c.prompt} hint={c.promptHint} rows={3} required idPrefix="nq" />
            <TextareaField name="choices" label={c.choices} rows={4} idPrefix="nq" />
            <TextareaField name="accepted" label={c.accepted} rows={2} idPrefix="nq" />
            <TextareaField name="explanation" label={c.explanation} rows={2} idPrefix="nq" />
          </ActionForm>
        </details>
      </section>
    </WorkspacePage>
  );
}
