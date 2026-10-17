import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClasses } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { RichText } from '@/components/ui/rich-text';
import { ArcPhoto, Bubble, DotGrid, Icon, PhotoPlaceholder } from '@/features/site/brand';
import { CourseTabs, type TabCourse } from '@/features/site/course-tabs';
import { formatPrice } from '@/features/site/format';
import { SignupForm } from '@/features/site/signup-form';
import { isLocale, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries/ru';
import { getDictionary } from '@/i18n/get-dictionary';
import { fmt } from '@/lib/format';
import { mapLinks, parseSiteContent, pick, waLink } from '@/server/public/content';
import type { Course } from '@/server/public/schemas';
import { getCatalog, getPage, getSite, getTeachers } from '@/server/public/site';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getDictionary(locale);
  const site = await getSite();
  const data = site.ok ? site.data : null;
  if (!data) return {};
  const c = parseSiteContent(data.settings);
  const title = c.hero ? `${data.name} — ${c.hero.lines.map((l) => pick(l, locale)).join(' ').replace(/[,.]\s*$/, '')}` : data.name;
  const description = pick(c.hero?.subtitle, locale) || t.meta.description;
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', locale, siteName: data.name, ...(c.logo ? { images: [{ url: c.logo }] } : {}) },
  };
}

const priceText = (c: Course, locale: Locale, t: Dictionary) =>
  c.price ? `${formatPrice(locale, c.price.amount, c.price.currency)} ${t.site.priceUnits[c.price.unit]}` : t.site.home2.priceOnRequest;

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const h = t.site.home2;
  const [site, catalog, teachers, faq, hdrs] = await Promise.all([getSite(), getCatalog(), getTeachers(), getPage('faq', locale), headers()]);
  const data = site.ok ? site.data : null;
  const name = data?.name ?? t.site.home.fallbackTitle;
  const c = parseSiteContent(data?.settings);
  const courses = catalog.ok ? catalog.data : [];
  const branches = data?.branches ?? [];
  const mainWa = c.social?.whatsapp ?? branches.find((b) => b.whatsapp)?.whatsapp ?? undefined;
  const instagram = c.social?.instagram?.[0]?.url;
  const courseTitle = (id: string) => courses.find((x) => x.id === id)?.title;

  const tabCourses: TabCourse[] = courses.map((x) => ({
    id: x.id,
    title: x.title,
    description: x.description,
    category: x.category ?? null,
    ageNote: x.ageNote ?? null,
    price: priceText(x, locale, t),
    href: `/${locale}/courses/${x.id}`,
  }));

  // Разметка schema.org: школа и каждый филиал (адрес, телефон).
  const jsonLd = data
    ? {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'EducationalOrganization', name: data.name, ...(c.social?.instagram?.length ? { sameAs: c.social.instagram.map((i) => i.url) } : {}) },
          ...branches.map((b) => ({
            '@type': 'LocalBusiness',
            name: `${data.name} — ${b.name}`,
            address: { '@type': 'PostalAddress', streetAddress: b.address ?? undefined, addressLocality: b.city, addressCountry: 'KG' },
            ...(b.whatsapp || b.phone ? { telephone: b.whatsapp ?? b.phone } : {}),
          })),
        ],
      }
    : null;

  return (
    <div className="space-y-20">
      {jsonLd ? (
        <script type="application/ld+json" nonce={hdrs.get('x-nonce') ?? undefined} dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      ) : null}
      {!site.ok ? <Notice tone="warning">{t.site.unavailable}</Notice> : data === null ? <Notice tone="info">{t.site.notConfigured}</Notice> : null}

      {/* 1. Hero — как рекламный баннер школы */}
      <section aria-labelledby="hero-h" className="fade-up relative grid items-center gap-10 overflow-hidden lg:grid-cols-[1.1fr_1fr]">
        <div className="relative space-y-6">
          <h1 id="hero-h" className="heading-caps sparks text-[2.25rem] sm:text-5xl lg:text-[3.5rem]">
            {c.hero ? (
              c.hero.lines.map((line, i) => (
                <span key={i} className={`block ${i === (c.hero!.accentLine ?? 1) ? 'text-brand-600' : ''}`}>
                  {pick(line, locale)}
                </span>
              ))
            ) : (
              <span className="block">{name}</span>
            )}
          </h1>
          <p className="max-w-xl text-lg text-ink">{pick(c.hero?.subtitle, locale) || h.heroFallback}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link href={`/${locale}#signup`} className={buttonClasses('cta', 'lg', 'sm:whitespace-nowrap')}>
              {h.heroCta}
            </Link>
            {mainWa ? (
              <a href={waLink(mainWa)} rel="noopener noreferrer" target="_blank" className={buttonClasses('outline', 'lg', 'sm:whitespace-nowrap')}>
                <Icon name="whatsapp" className="size-5" />
                {h.heroWhatsapp}
              </a>
            ) : null}
          </div>
        </div>
        <ArcPhoto className="mx-auto w-full max-w-md pt-6">
          {c.hero?.photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- фото со своего домена
            <img src={c.hero.photo} alt={pick(c.hero.photoNote, locale) || name} className="relative mx-auto max-h-[28rem] w-auto object-contain" loading="eager" />
          ) : (
            <PhotoPlaceholder label={fmt(h.photo, { what: pick(c.hero?.photoNote, locale) || '—' })} className="mx-auto h-80 w-4/5" />
          )}
          {(c.hero?.badges ?? []).map((b, i) => (
            <Bubble key={b} className={`absolute text-sm shadow-[var(--shadow-card)] ${['left-0 top-10', 'right-0 top-1/3', 'bottom-10 left-6', 'bottom-24 right-2'][i]}`}>
              {b}
            </Bubble>
          ))}
        </ArcPhoto>
      </section>

      {/* 2. Цифры */}
      {c.stats?.length ? (
        <section aria-label={h.statsTitle} className="fade-up">
          <ul className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            {c.stats.map((s) => (
              <li key={s.value + pick(s.label, 'ru')} className="flex flex-col items-start gap-3">
                <span className="heading-caps text-4xl sm:text-5xl">{s.value}</span>
                <Bubble className="text-xs sm:text-sm">{pick(s.label, locale)}</Bubble>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 3. Курсы */}
      <section id="courses" aria-labelledby="courses-h" className="scroll-mt-32 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="courses-h" className="heading-caps sparks text-3xl sm:text-4xl">
            {h.coursesTitle}
          </h2>
          <Link className="link font-semibold" href={`/${locale}/courses`}>
            {t.site.home.allCourses}
          </Link>
        </div>
        {tabCourses.length ? (
          <CourseTabs courses={tabCourses} labels={t.site.categories} allLabel={h.all} moreLabel={h.moreCourse} />
        ) : (
          <p className="text-muted">{t.site.home.noCourses}</p>
        )}
      </section>

      {/* 4. Почему мы */}
      {c.advantages?.length ? (
        <section aria-labelledby="why-h" className="relative -mx-4 space-y-8 bg-surface-muted px-4 py-14 sm:rounded-[var(--radius-card)] sm:px-8">
          <DotGrid className="right-4 top-4" />
          <h2 id="why-h" className="heading-caps sparks text-3xl sm:text-4xl">
            {fmt(h.whyTitle, { name })}
          </h2>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {c.advantages.map((a) => (
              <li key={pick(a.title, 'ru')} className="flex gap-4 rounded-[var(--radius-card)] bg-surface p-5 shadow-[var(--shadow-card)]">
                <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                  <Icon name={a.icon} />
                </span>
                <div>
                  <h3 className="font-bold text-heading">{pick(a.title, locale)}</h3>
                  {a.text ? <p className="mt-1 text-sm text-muted">{pick(a.text, locale)}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 5. Результаты учеников */}
      {c.results?.length ? (
        <section id="results" aria-labelledby="results-h" className="scroll-mt-32 space-y-8">
          <h2 id="results-h" className="heading-caps sparks text-3xl sm:text-4xl">
            {h.resultsTitle}
          </h2>
          <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {c.results.map((r) => (
              <li key={pick(r.name, 'ru') + pick(r.value, 'ru')} className="space-y-4 text-center">
                <ArcPhoto className="mx-auto w-56">
                  {r.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- фото со своего домена
                    <img src={r.photo} alt={pick(r.name, locale)} className="relative mx-auto h-56 w-auto object-contain" loading="lazy" />
                  ) : (
                    <PhotoPlaceholder label={fmt(h.photo, { what: pick(r.name, locale) })} className="mx-auto h-52 w-44" />
                  )}
                </ArcPhoto>
                <p className="heading-caps text-3xl">{pick(r.value, locale)}</p>
                <Bubble className="text-sm">{pick(r.caption, locale)}</Bubble>
                <p className="pt-2 font-semibold text-ink">{pick(r.name, locale)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 6. Клубы и мероприятия */}
      {c.clubs?.length ? (
        <section aria-labelledby="clubs-h" className="space-y-6">
          <h2 id="clubs-h" className="heading-caps sparks text-3xl sm:text-4xl">
            {h.clubsTitle}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {c.clubs.map((club) => (
              <li key={pick(club.title, 'ru')} className="rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
                <p className="font-bold text-brand-800">{pick(club.title, locale)}</p>
                {club.text ? <p className="text-sm text-muted">{pick(club.text, locale)}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 7. Акции — зелёная полоса */}
      {c.promos?.length ? (
        <section aria-labelledby="promo-h" className="-mx-4 bg-brand-800 px-4 py-10 text-white sm:rounded-[var(--radius-card)] sm:px-10">
          <h2 id="promo-h" className="text-sm font-bold uppercase tracking-wide text-white/85">
            {h.promoTitle}
          </h2>
          <ul className="mt-3 space-y-3">
            {c.promos.map((p) => (
              <li key={pick(p, 'ru')} className="text-2xl font-extrabold uppercase leading-tight sm:text-3xl">
                {pick(p, locale)}
              </li>
            ))}
          </ul>
          <Link href={`/${locale}#signup`} className="mt-6 inline-flex min-h-12 items-center rounded-[var(--radius-control)] bg-white px-6 font-bold uppercase tracking-[0.02em] text-brand-800 no-underline hover:bg-brand-50">
            {h.signup}
          </Link>
        </section>
      ) : null}

      {/* 8. Преподаватели — горизонтальная лента */}
      <section id="teachers" aria-labelledby="teachers-h" className="scroll-mt-32 space-y-6">
        <h2 id="teachers-h" className="heading-caps sparks text-3xl sm:text-4xl">
          {h.teachersTitle}
        </h2>
        {teachers.ok && teachers.data.length ? (
          <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2">
            {teachers.data.map((tc) => (
              <li key={tc.displayName} className="w-64 shrink-0 snap-start rounded-[var(--radius-card)] bg-surface p-5 shadow-[var(--shadow-card)]">
                <ArcPhoto className="mx-auto mb-4 w-40">
                  <PhotoPlaceholder label={fmt(h.photo, { what: tc.displayName })} className="mx-auto h-36 w-28" />
                </ArcPhoto>
                <p className="font-bold text-heading">{tc.displayName}</p>
                {tc.languages.length ? <p className="text-sm text-brand-700">{tc.languages.join(' · ').toUpperCase()}</p> : null}
                {pick(tc.bio, locale) ? <p className="mt-2 text-sm text-muted">{pick(tc.bio, locale)}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{h.teachersEmpty}</p>
        )}
      </section>

      {/* 9. Филиалы */}
      <section id="branches" aria-labelledby="branches-h" className="scroll-mt-32 space-y-6">
        <h2 id="branches-h" className="heading-caps sparks text-3xl sm:text-4xl">
          {h.branchesTitle}
        </h2>
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {branches.map((b) => {
            const maps = b.address ? mapLinks(b.address, b.city) : null;
            const offered = (b.courseIds ?? []).map(courseTitle).filter((x): x is string => Boolean(x));
            return (
              <li key={b.id} className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-surface p-5 shadow-[var(--shadow-card)]">
                <div className="flex items-start gap-3">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                    <Icon name="pin" className="size-5" />
                  </span>
                  <div>
                    <h3 className="font-bold text-heading">{b.name}</h3>
                    <p className="text-sm text-muted">{[b.address, b.city].filter(Boolean).join(', ')}</p>
                  </div>
                </div>
                {offered.length ? (
                  <ul aria-label={h.branchCourses} className="flex flex-wrap gap-1.5">
                    {offered.map((title) => (
                      <li key={title} className="rounded-full bg-surface-muted px-2.5 py-1 text-xs font-semibold text-brand-800">
                        {title}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-auto space-y-1 pt-1">
                  {b.whatsapp ? (
                    <a href={waLink(b.whatsapp)} rel="noopener noreferrer" target="_blank" className={buttonClasses('cta', 'md')}>
                      <Icon name="whatsapp" className="size-5" />
                      {h.whatsapp}
                    </a>
                  ) : null}
                  {maps ? (
                    <p className="flex flex-wrap gap-x-4">
                      <a href={maps.google} rel="noopener noreferrer" target="_blank" className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700">
                        {h.mapGoogle}
                      </a>
                      <a href={maps.twoGis} rel="noopener noreferrer" target="_blank" className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700">
                        {h.map2gis}
                      </a>
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 10. Заявка */}
      <section id="signup" aria-labelledby="signup-h" className="relative -mx-4 scroll-mt-32 bg-surface-muted px-4 py-14 sm:rounded-[var(--radius-card)] sm:px-10">
        <DotGrid className="bottom-4 right-4" />
        <div className="relative mx-auto max-w-2xl space-y-6">
          <div className="space-y-2">
            <h2 id="signup-h" className="heading-caps sparks text-3xl sm:text-4xl">
              {h.signupTitle}
            </h2>
            <p className="text-muted">{h.signupLead}</p>
          </div>
          {data?.legal.privacy && courses.length && branches.length ? (
            <SignupForm
              locale={locale}
              t={t}
              consentVersion={data.legal.privacy}
              courses={courses.map((x) => ({ id: x.id, title: x.title, category: x.category ?? null, branchIds: x.branchIds ?? [] }))}
              branches={branches.map((b) => ({ id: b.id, name: b.name }))}
              instagramUrl={instagram}
            />
          ) : (
            <Notice tone="info">{t.site.lead.closed}</Notice>
          )}
        </div>
      </section>

      {/* 11. Частые вопросы (страница FAQ школы) */}
      {faq.ok && faq.data ? (
        <section aria-labelledby="faq-h" className="space-y-6">
          <h2 id="faq-h" className="heading-caps sparks text-3xl sm:text-4xl">
            {h.faqTitle}
          </h2>
          <RichText text={faq.data.body} />
        </section>
      ) : null}
    </div>
  );
}
