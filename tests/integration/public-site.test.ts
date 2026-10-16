import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogSchema,
  LegalSchema,
  LevelsSchema,
  PageSchema,
  SiteSchema,
  TeachersSchema,
  TrialSlotsSchema,
  filterCatalog,
} from '@/server/public/schemas';
import { BRANCH, COURSE, ORG, U, createSeededDb } from '../db/fixtures';
import { as } from '../db/harness';

/** Ответы настоящих SQL-функций public_* должны проходить TS-схемы сайта. */
let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
  const body = 'Текст документа. '.repeat(10);
  await db.exec(`
    update public.branches set phone = '+996 312 000 000', email = 'a1@example.test', address = 'ул. Токтогула, 1' where id = '${BRANCH.A1}';
    update public.courses set public_price = 4500.50, public_price_currency = 'KGS', public_price_unit = 'month', description = 'Курс' where id = '${COURSE.A}';
    insert into public.legal_documents (organization_id, kind, locale, version, title, body, status) values ('${ORG.A}', 'privacy', 'ru', '2026-10-15', 'Политика', '${body}', 'published');
    insert into public.public_pages (organization_id, slug, locale, title, body, status) values ('${ORG.A}', 'about', 'ru', 'О школе', 'Текст', 'published');
    insert into public.trial_slots (organization_id, branch_id, course_id, period, format, capacity) values
      ('${ORG.A}', '${BRANCH.A1}', '${COURSE.A}', tstzrange(now() + interval '1 day', now() + interval '1 day 1 hour'), 'offline', 3);
    insert into public.teacher_public_profiles (organization_id, profile_id, display_name, bio, languages) values
      ('${ORG.A}', '${U.teacherA1}', 'Айгерим', '{"ru": "Преподаю английский"}', '{en}');
    select set_config('request.jwt.claims', '{"sub": "${U.teacherA1}"}', false);
    update public.teacher_public_profiles set status = 'published' where profile_id = '${U.teacherA1}';
    select set_config('request.jwt.claims', '', false);
  `);
}, 60_000);

const rpc = (sql: string, params: unknown[]) => as(db, null, async (tx) => (await tx.query<{ r: unknown }>(sql, params)).rows[0]?.r);

describe('public RPC responses match the site schemas', () => {
  it('site', async () => {
    const site = SiteSchema.nullable().parse(await rpc('select public.public_site($1) as r', ['school-a']));
    expect(site?.branches.find((b) => b.id === BRANCH.A1)?.phone).toBe('+996 312 000 000');
    expect(site?.legal.privacy).toBe('2026-10-15');
    expect(SiteSchema.nullable().parse(await rpc('select public.public_site($1) as r', ['missing']))).toBeNull();
  });

  it('catalog keeps money as an exact decimal string', async () => {
    const catalog = CatalogSchema.parse(await rpc('select public.public_catalog($1) as r', ['school-a']));
    expect(catalog[0]?.price).toEqual({ amount: '4500.50', currency: 'KGS', unit: 'month' });
    expect(filterCatalog(catalog, { branch: BRANCH.A2 })).toHaveLength(1);
    expect(filterCatalog(catalog, { language: 'de' })).toHaveLength(0);
  });

  it('levels, teachers, trial slots, pages and legal documents', async () => {
    expect(LevelsSchema.parse(await rpc('select public.public_levels($1) as r', ['school-a']))[0]?.levels[0]?.code).toBe('A1');
    expect(TeachersSchema.parse(await rpc('select public.public_teachers($1) as r', ['school-a']))).toEqual([
      { displayName: 'Айгерим', bio: { ru: 'Преподаю английский' }, languages: ['en'] },
    ]);
    expect(TrialSlotsSchema.parse(await rpc('select public.public_trial_slots($1) as r', ['school-a']))[0]?.freeSpots).toBe(3);
    expect(PageSchema.parse(await rpc('select public.public_page($1, $2, $3) as r', ['school-a', 'about', 'ru']))?.title).toBe('О школе');
    expect(LegalSchema.parse(await rpc('select public.public_legal($1, $2, $3) as r', ['school-a', 'privacy', 'ru']))?.version).toBe('2026-10-15');
  });
});

describe('filterCatalog', () => {
  it('treats hybrid courses as matching both online and offline filters', async () => {
    const catalog = CatalogSchema.parse(await rpc('select public.public_catalog($1) as r', ['school-a']));
    const hybrid = catalog.map((c) => ({ ...c, format: 'hybrid' as const }));
    expect(filterCatalog(hybrid, { format: 'online' })).toHaveLength(1);
    expect(filterCatalog(catalog, { format: 'online' })).toHaveLength(0); // курс A — очный
    expect(filterCatalog(catalog, { level: 'A1', language: 'en' })).toHaveLength(1);
  });
});
