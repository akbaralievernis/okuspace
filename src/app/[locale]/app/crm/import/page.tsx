import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SelectField, TextareaField } from '@/components/ui/controls';
import { Field } from '@/components/ui/field';
import { ActionForm } from '@/features/admin/action-form';
import { WorkspacePage, authMessages } from '@/features/admin/workspace-page';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { requireAccess } from '@/server/auth/session';
import { can } from '@/server/authz/check';
import { importContactsAction } from '@/server/crm/actions';
import { createUserClient } from '@/server/supabase/server';

export default async function CrmImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAccess(locale, `/${locale}/app/crm/import`);
  const t = getDictionary(locale);
  const c = t.crm;
  const m = ctx.memberships.filter((x) => x.status === 'active');
  const orgs = [...new Set(m.filter((x) => can(m, 'lead.manage', x.organizationId, x.branchId)).map((x) => x.organizationId))];
  const db = await createUserClient();
  const { data: branches } = orgs.length ? await db.from('branches').select('id, organization_id, name').in('organization_id', orgs).order('name') : { data: [] };
  const allowed = (branches ?? []).filter((b) => can(m, 'lead.manage', b.organization_id as string, b.id as string));

  return (
    <WorkspacePage ctx={ctx} locale={locale} t={t} title={c.importTitle} allowed={allowed.length > 0}>
      <p>
        <Link className="link" href={`/${locale}/app/crm`}>
          {c.back}
        </Link>
      </p>
      <p>{c.importHint}</p>
      <ActionForm action={importContactsAction} submitLabel={c.importSubmit} pendingLabel={t.common.pending} messages={authMessages(t)} fieldLabels={{ file: c.file }}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="organizationId" value={(allowed[0]?.organization_id as string) ?? ''} />
        <SelectField name="branchId" label={c.branch} idPrefix="im">
          {allowed.map((b) => (
            <option key={b.id as string} value={b.id as string}>
              {b.name as string}
            </option>
          ))}
        </SelectField>
        <Field name="file" label={c.file} type="file" accept=".csv,text/csv" idPrefix="im" />
        <TextareaField name="csv" label={c.paste} rows={6} idPrefix="im" />
      </ActionForm>
    </WorkspacePage>
  );
}
