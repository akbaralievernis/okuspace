import { notFound } from 'next/navigation';
import { EmptyState, Notice, PageHeader } from '@/components/ui/notice';
import { formatDateTime, formatTime } from '@/features/site/format';
import { LeadForm } from '@/features/site/lead-form';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { getSite, getTrialSlots } from '@/server/public/site';

export default async function TrialPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const p = t.site.trial;
  const [site, slots] = await Promise.all([getSite(), getTrialSlots()]);

  if (!site.ok || !slots.ok) {
    return (
      <>
        <PageHeader title={p.title} lead={p.lead} />
        <Notice tone="warning">{t.site.unavailable}</Notice>
      </>
    );
  }
  const privacy = site.data?.legal.privacy ?? null;
  const options = slots.data.map((s) => ({
    id: s.id,
    freeSpots: s.freeSpots,
    label: `${formatDateTime(locale, s.startsAt, s.timezone)}–${formatTime(locale, s.endsAt, s.timezone)} · ${s.city}, ${s.branch} · ${t.site.formats[s.format]}${s.course ? ` · ${s.course}` : ''}`,
  }));

  return (
    <>
      <PageHeader title={p.title} lead={p.lead} />
      {options.length === 0 ? (
        <EmptyState title={p.empty} />
      ) : !privacy ? (
        <Notice tone="info">{t.site.lead.closed}</Notice>
      ) : (
        <div className="max-w-xl">
          <LeadForm kind="trial" locale={locale} t={t} consentVersion={privacy} slots={options} submitLabel={p.submit} />
        </div>
      )}
    </>
  );
}
