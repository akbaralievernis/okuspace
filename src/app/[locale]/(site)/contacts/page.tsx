import { notFound } from 'next/navigation';
import { Notice, PageHeader } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { BranchList } from '@/features/site/branch-list';
import { LeadForm } from '@/features/site/lead-form';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getPage, getSite } from '@/server/public/site';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ course?: string }> };

export default async function ContactsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const c = t.site.contacts;
  const course = (await searchParams).course;
  const courseId = course && /^[0-9a-f-]{36}$/i.test(course) ? course : undefined;
  const [site, page] = await Promise.all([getSite(), getPage('contacts', locale)]);

  if (!site.ok) {
    return (
      <>
        <PageHeader title={c.title} />
        <Notice tone="warning">{t.site.unavailable}</Notice>
      </>
    );
  }
  const privacy = site.data?.legal.privacy ?? null;
  const branches = site.data?.branches ?? [];

  return (
    <>
      <PageHeader title={page.ok && page.data ? page.data.title : c.title} />
      <div className="grid gap-10 lg:grid-cols-2">
        <div className="space-y-8">
          {page.ok && page.data ? <RichText text={page.data.body} /> : <p className="text-muted">{t.site.pages.contactsEmpty}</p>}
          {branches.length ? <BranchList branches={branches} labels={t.site.branches} /> : null}
        </div>
        <section aria-labelledby="contact-form-h" className="space-y-4">
          <h2 id="contact-form-h" className="text-2xl font-bold">
            {c.formTitle}
          </h2>
          {privacy ? (
            <LeadForm kind="contact" locale={locale} t={t} consentVersion={privacy} courseId={courseId} submitLabel={c.submit} />
          ) : (
            <Notice tone="info">{t.site.lead.closed}</Notice>
          )}
        </section>
      </div>
    </>
  );
}
