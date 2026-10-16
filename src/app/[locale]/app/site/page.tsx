import { notFound } from 'next/navigation';
import { AppHeader, appNav } from '@/components/app-header';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { Badge, Notice, PageHeader } from '@/components/ui/notice';
import { ActionForm } from '@/features/admin/action-form';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary, localeNames } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { createLegalDraftAction, deleteLegalDraftAction, publishLegalAction, savePageAction } from '@/server/site-admin/actions';
import { LEGAL_KINDS, SITE_PAGES } from '@/server/site-admin/schemas';
import { createUserClient } from '@/server/supabase/server';

export default async function SiteAdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/site`);
  const t = getDictionary(locale);
  const a = t.admin;
  const messages = { errors: t.auth.errors, fieldErrors: t.auth.fieldErrors, success: t.auth.success };
  const orgId = ctx.memberships.find((m) => can(ctx.memberships, 'site.manage', m.organizationId, null))?.organizationId;

  if (!orgId) {
    return (
      <>
        <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
        <main id="main" className="container-page py-8">
          <PageHeader title={a.site.title} />
          <p>{a.common.noRights}</p>
        </main>
      </>
    );
  }

  const client = await createUserClient();
  const [pagesRes, docsRes] = await Promise.all([
    client.from('public_pages').select('slug, locale, title, body, status').eq('organization_id', orgId),
    client.from('legal_documents').select('id, kind, locale, version, title, status, published_at').eq('organization_id', orgId).order('version', { ascending: false }),
  ]);
  const pages = new Map((pagesRes.data ?? []).map((p) => [`${p.slug}:${p.locale}`, p]));
  const docs = docsRes.data ?? [];
  const pageLabels = { about: t.site.nav.about, contacts: t.site.nav.contacts, faq: t.site.nav.faq };
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <AppHeader locale={locale} t={t} items={appNav(ctx, locale, t)} />
      <main id="main" className="container-page space-y-12 py-8">
        <PageHeader title={a.site.title} />
        {pagesRes.error || docsRes.error ? <Notice tone="warning">{t.auth.errors.unavailable}</Notice> : null}

        <section aria-labelledby="pages-h" className="space-y-4">
          <h2 id="pages-h" className="text-2xl font-bold">
            {a.site.pagesTitle}
          </h2>
          <p className="text-sm text-muted">{a.site.bodyHint}</p>
          {SITE_PAGES.map((slug) =>
            locales.map((loc) => {
              const page = pages.get(`${slug}:${loc}`);
              return (
                <details key={`${slug}-${loc}`} className="rounded-[var(--radius-card)] border border-border p-4">
                  <summary className="cursor-pointer font-medium">
                    {pageLabels[slug]} · {localeNames[loc]}{' '}
                    <Badge tone={page?.status === 'published' ? 'success' : 'neutral'}>{page?.status === 'published' ? a.common.published : a.common.draft}</Badge>
                  </summary>
                  <ActionForm
                    action={savePageAction}
                    submitLabel={a.common.save}
                    pendingLabel={t.common.pending}
                    messages={messages}
                    fieldLabels={{ title: a.site.titleField, body: a.site.body }}
                    className="mt-4 space-y-4"
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="organizationId" value={orgId} />
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="contentLocale" value={loc} />
                    <Field name="title" label={a.site.titleField} defaultValue={page?.title ?? ''} required idPrefix={`page-${slug}-${loc}`} />
                    <TextareaField name="body" label={a.site.body} defaultValue={page?.body ?? ''} rows={10} required idPrefix={`page-${slug}-${loc}`} />
                    <SelectField name="status" label={a.common.status} defaultValue={page?.status ?? 'draft'} idPrefix={`page-${slug}-${loc}`}>
                      <option value="draft">{a.common.draft}</option>
                      <option value="published">{a.common.published}</option>
                    </SelectField>
                  </ActionForm>
                </details>
              );
            }),
          )}
        </section>

        <section aria-labelledby="legal-h" className="space-y-4">
          <h2 id="legal-h" className="text-2xl font-bold">
            {a.site.legalTitle}
          </h2>
          <Notice tone="warning">{a.site.lawyerNote}</Notice>
          <p className="text-sm text-muted">{a.site.legalHint}</p>

          {docs.length === 0 ? (
            <p>{a.site.noDocuments}</p>
          ) : (
            <ul className="space-y-3">
              {docs.map((d) => (
                <li key={d.id as string} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border px-4 py-3">
                  <span>
                    {t.site.legal[d.kind as (typeof LEGAL_KINDS)[number]]} · {localeNames[d.locale as 'ru']} · {d.version as string}{' '}
                    <Badge tone={d.status === 'published' ? 'success' : 'neutral'}>{d.status === 'published' ? a.common.published : a.common.draft}</Badge>
                  </span>
                  {d.status === 'draft' ? (
                    <span className="flex flex-wrap gap-2">
                      <ActionForm
                        action={publishLegalAction}
                        submitLabel={a.site.publish}
                        pendingLabel={t.common.pending}
                        messages={messages}
                        className="flex flex-wrap items-center gap-2"
                        confirm={{ title: a.site.publishTitle, text: a.site.publishText, confirmLabel: a.site.publish, cancelLabel: a.common.cancel }}
                      >
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="id" value={d.id as string} />
                      </ActionForm>
                      <ActionForm
                        action={deleteLegalDraftAction}
                        submitLabel={a.site.deleteDraft}
                        pendingLabel={t.common.pending}
                        messages={messages}
                        variant="danger"
                        className="flex flex-wrap items-center gap-2"
                        confirm={{ title: a.site.deleteTitle, text: a.site.deleteText, confirmLabel: a.site.deleteDraft, cancelLabel: a.common.cancel }}
                      >
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="id" value={d.id as string} />
                      </ActionForm>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <details className="rounded-[var(--radius-card)] border border-border p-4">
            <summary className="cursor-pointer font-medium">{a.site.newVersion}</summary>
            <ActionForm
              action={createLegalDraftAction}
              submitLabel={a.site.newVersion}
              pendingLabel={t.common.pending}
              messages={messages}
              fieldLabels={{ title: a.site.titleField, body: a.site.body, version: a.site.version }}
              className="mt-4 space-y-4"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="organizationId" value={orgId} />
              <SelectField name="kind" label={a.site.kind} idPrefix="legal">
                {LEGAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t.site.legal[k]}
                  </option>
                ))}
              </SelectField>
              <SelectField name="contentLocale" label={a.common.locale} defaultValue={locale} idPrefix="legal">
                {locales.map((l) => (
                  <option key={l} value={l}>
                    {localeNames[l]}
                  </option>
                ))}
              </SelectField>
              <Field name="version" type="date" label={a.site.version} defaultValue={today} required idPrefix="legal" />
              <Field name="title" label={a.site.titleField} required idPrefix="legal" />
              <TextareaField name="body" label={a.site.body} hint={a.site.bodyHint} rows={14} required idPrefix="legal" />
            </ActionForm>
          </details>
        </section>
      </main>
    </>
  );
}
