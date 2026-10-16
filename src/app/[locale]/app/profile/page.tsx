import { notFound } from 'next/navigation';
import { AppHeader, appNav } from '@/components/app-header';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Notice, PageHeader } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { isLocale } from '@/i18n/config';
import { getDictionary, localeNames } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { requireAccess } from '@/server/auth/session';
import { saveTeacherProfileAction } from '@/server/site-admin/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function TeacherProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/profile`);
  const t = getDictionary(locale);
  const p = t.admin.profile;
  const messages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const orgIds = [...new Set(ctx.memberships.filter((m) => m.role === 'teacher' && m.status === 'active').map((m) => m.organizationId))];

  const client = await createUserClient();
  const [{ data: profiles, error }, { data: orgs }] = await Promise.all([
    client.from('teacher_public_profiles').select('organization_id, display_name, bio, languages, status').eq('profile_id', ctx.user.id),
    orgIds.length ? client.from('organizations').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const byOrg = new Map((profiles ?? []).map((x) => [x.organization_id as string, x]));

  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="container-page max-w-2xl space-y-8 py-8">
        <PageHeader title={p.title} lead={p.intro} />
        {orgIds.length === 0 ? <p>{p.notTeacher}</p> : null}
        {error ? <Notice tone="warning">{t.auth.errors.unavailable}</Notice> : null}
        {(orgs ?? []).map((org) => {
          const current = byOrg.get(org.id as string);
          const bio = (current?.bio ?? {}) as Record<string, string>;
          const published = current?.status === 'published';
          const prefix = `profile-${org.id as string}`;
          return (
            <section key={org.id as string} aria-label={org.name as string} className="space-y-4 rounded-[var(--radius-card)] border border-border p-5">
              <h2 className="text-lg font-semibold">
                {org.name as string} <Badge tone={published ? 'success' : 'neutral'}>{published ? t.admin.common.published : t.admin.common.draft}</Badge>
              </h2>
              <ActionForm
                action={saveTeacherProfileAction}
                submitLabel={t.admin.common.save}
                pendingLabel={t.common.pending}
                messages={messages}
                fieldLabels={{ displayName: p.displayName, languages: p.languages }}
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="organizationId" value={org.id as string} />
                <Field name="displayName" label={p.displayName} defaultValue={(current?.display_name as string) ?? ''} required idPrefix={prefix} />
                {(['ky', 'ru', 'en'] as const).map((l) => (
                  <TextareaField key={l} name={`bio_${l}`} label={fmt(p.bio, { lang: localeNames[l] })} defaultValue={bio[l] ?? ''} maxLength={3000} idPrefix={prefix} />
                ))}
                <Field name="languages" label={p.languages} defaultValue={((current?.languages as string[]) ?? []).join(', ')} idPrefix={prefix} />
                <SelectField name="status" label={t.admin.common.status} defaultValue={published ? 'published' : 'draft'} idPrefix={prefix}>
                  <option value="draft">{p.unpublish} / {p.saveDraft}</option>
                  <option value="published">{p.publish}</option>
                </SelectField>
              </ActionForm>
            </section>
          );
        })}
      </main>
    </>
  );
}
