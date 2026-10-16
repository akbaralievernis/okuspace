import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, EmptyState } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { saveCourseAction, saveLanguageAction, saveLevelAction } from '@/server/lms/actions';
import { createUserClient } from '@/server/supabase/server';

type Course = {
  id: string; language_id: string; level_id: string; title: string; description: string | null; format: string; kind: string;
  duration_weeks: number; lessons_per_week: number; status: string; public_price: string | null; public_price_currency: string | null; public_price_unit: string | null;
};

export default async function CatalogAdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/catalog`);
  const t = getDictionary(locale);
  const c = t.lms.catalog;
  const msg = authMessages(t);
  const orgId = ctx.memberships.find((m) => can(ctx.memberships, 'catalog.manage', m.organizationId, null))?.organizationId;
  if (!orgId) return <WorkspacePage ctx={ctx} locale={locale} t={t} title={c.title} allowed={false} />;

  const db = await createUserClient();
  const [langs, levels, courses] = await Promise.all([
    db.from('languages').select('id, code, name').eq('organization_id', orgId).order('name'),
    db.from('course_levels').select('id, language_id, code, title, framework, sort_order').eq('organization_id', orgId).order('sort_order'),
    db.from('courses').select('id, language_id, level_id, title, description, format, kind, duration_weeks, lessons_per_week, status, public_price, public_price_currency, public_price_unit').eq('organization_id', orgId).order('title'),
  ]);
  const languages = langs.data ?? [];
  const levelRows = levels.data ?? [];
  const canCreateCourse = languages.length > 0 && levelRows.length > 0;

  const courseFields = (course: Course | null, prefix: string) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organizationId" value={orgId} />
      <input type="hidden" name="courseId" value={course?.id ?? ''} />
      <Field name="title" label={t.lms.common.title} defaultValue={course?.title ?? ''} required idPrefix={prefix} />
      <TextareaField name="description" label={t.lms.common.description} defaultValue={course?.description ?? ''} idPrefix={prefix} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="languageId" label={c.language} defaultValue={course?.language_id} idPrefix={prefix}>
          {languages.map((l) => (
            <option key={l.id as string} value={l.id as string}>
              {l.name as string}
            </option>
          ))}
        </SelectField>
        <SelectField name="levelId" label={c.level} defaultValue={course?.level_id} idPrefix={prefix}>
          {levelRows.map((lv) => (
            <option key={lv.id as string} value={lv.id as string}>
              {languages.find((l) => l.id === lv.language_id)?.code as string} · {lv.code as string} — {lv.title as string}
            </option>
          ))}
        </SelectField>
        <SelectField name="format" label={c.format} defaultValue={course?.format ?? 'offline'} idPrefix={prefix}>
          {(['offline', 'online', 'hybrid'] as const).map((f) => (
            <option key={f} value={f}>
              {t.site.formats[f]}
            </option>
          ))}
        </SelectField>
        <SelectField name="kind" label={c.kind} defaultValue={course?.kind ?? 'group'} idPrefix={prefix}>
          {(['group', 'individual'] as const).map((k) => (
            <option key={k} value={k}>
              {t.site.kinds[k]}
            </option>
          ))}
        </SelectField>
        <Field name="durationWeeks" type="number" min={1} max={260} label={c.durationWeeks} defaultValue={course?.duration_weeks ?? 12} idPrefix={prefix} />
        <Field name="lessonsPerWeek" type="number" min={1} max={14} label={c.lessonsPerWeek} defaultValue={course?.lessons_per_week ?? 2} idPrefix={prefix} />
        <Field name="price" inputMode="decimal" label={c.price} defaultValue={course?.public_price ?? ''} idPrefix={prefix} />
        <Field name="currency" label={c.currency} defaultValue={course?.public_price_currency ?? 'KGS'} maxLength={3} idPrefix={prefix} />
        <SelectField name="priceUnit" label={c.priceUnit} defaultValue={course?.public_price_unit ?? 'month'} idPrefix={prefix}>
          {(['month', 'course', 'lesson', 'hour'] as const).map((u) => (
            <option key={u} value={u}>
              {t.site.priceUnits[u]}
            </option>
          ))}
        </SelectField>
        <SelectField name="status" label={t.lms.common.status} defaultValue={course?.status ?? 'draft'} idPrefix={prefix}>
          {(['draft', 'published', 'archived'] as const).map((s) => (
            <option key={s} value={s}>
              {t.lms.common.statuses[s]}
            </option>
          ))}
        </SelectField>
      </div>
    </>
  );

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={c.title} unavailable={!!(langs.error || levels.error || courses.error)}>
      <section aria-labelledby="lang-h" className="space-y-4">
        <h2 id="lang-h" className="text-2xl font-bold">
          {c.languagesTitle}
        </h2>
        <ul className="space-y-3">
          {languages.map((l) => (
            <li key={l.id as string} className="rounded-[var(--radius-card)] border border-border p-4">
              <p className="font-semibold">
                {l.name as string} <Badge>{l.code as string}</Badge>
              </p>
              <p className="mt-1 text-sm text-muted">
                {c.levelsTitle}:{' '}
                {levelRows.filter((lv) => lv.language_id === l.id).map((lv) => `${lv.code as string} (${lv.title as string})`).join(', ') || '—'}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm font-medium">{c.addLevel}</summary>
                <ActionForm action={saveLevelAction} submitLabel={c.addLevel} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ code: c.levelCode, title: c.levelTitle }} className="mt-3 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="organizationId" value={orgId} />
                  <input type="hidden" name="languageId" value={l.id as string} />
                  <SelectField name="framework" label={c.framework} idPrefix={`lv-${l.id as string}`}>
                    <option value="cefr">{c.frameworks.cefr}</option>
                    <option value="custom">{c.frameworks.custom}</option>
                  </SelectField>
                  <Field name="code" label={c.levelCode} required idPrefix={`lv-${l.id as string}`} />
                  <Field name="title" label={c.levelTitle} required idPrefix={`lv-${l.id as string}`} />
                  <Field name="sortOrder" type="number" label={c.sortOrder} defaultValue={levelRows.filter((lv) => lv.language_id === l.id).length + 1} idPrefix={`lv-${l.id as string}`} />
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
        <details className="rounded-[var(--radius-card)] border border-border p-4">
          <summary className="cursor-pointer font-medium">{c.addLanguage}</summary>
          <ActionForm action={saveLanguageAction} submitLabel={c.addLanguage} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ code: c.languageCode, name: c.languageName }} className="mt-3 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organizationId" value={orgId} />
            <Field name="code" label={c.languageCode} required maxLength={3} idPrefix="lang" />
            <Field name="name" label={c.languageName} required idPrefix="lang" />
          </ActionForm>
        </details>
      </section>

      <section aria-labelledby="courses-h" className="space-y-4">
        <h2 id="courses-h" className="text-2xl font-bold">
          {c.coursesTitle}
        </h2>
        {!canCreateCourse ? <p className="text-muted">{c.noLanguages}</p> : null}
        {(courses.data ?? []).length === 0 ? (
          <EmptyState title={c.empty} />
        ) : (
          (courses.data as Course[]).map((course) => (
            <details key={course.id} className="rounded-[var(--radius-card)] border border-border p-4">
              <summary className="cursor-pointer font-medium">
                {course.title} <Badge tone={course.status === 'published' ? 'success' : 'neutral'}>{t.lms.common.statuses[course.status as 'draft']}</Badge>
              </summary>
              <ActionForm action={saveCourseAction} submitLabel={t.lms.common.save} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: t.lms.common.title, price: c.price }} className="mt-4 space-y-4">
                {courseFields(course, `course-${course.id}`)}
              </ActionForm>
            </details>
          ))
        )}
        {canCreateCourse ? (
          <details className="rounded-[var(--radius-card)] border border-border p-4">
            <summary className="cursor-pointer font-medium">{c.newCourse}</summary>
            <ActionForm action={saveCourseAction} submitLabel={t.lms.common.create} pendingLabel={t.common.pending} messages={msg} fieldLabels={{ title: t.lms.common.title, price: c.price }} className="mt-4 space-y-4">
              {courseFields(null, 'course-new')}
            </ActionForm>
          </details>
        ) : null}
      </section>
    </WorkspacePage>
  );
}
