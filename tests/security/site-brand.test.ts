import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogSchema, SiteSchema } from '@/server/public/schemas';
import { parseSiteContent } from '@/server/public/content';
import DEMO_USERS from '../../supabase/demo/users.json';
import { expectDenied } from '../db/assert';
import { as, asMfa, asService, count, createMigratedDb, rows, type Tx } from '../db/harness';

/**
 * Сайт American Dream: данные школы (курсы без языка, курсы по филиалам, содержимое главной),
 * заявка «на курс» и права на новые таблицы. База — демо-школа + скрипт данных American Dream.
 */
const root = join(__dirname, '..', '..');
const SEED = readFileSync(join(root, 'supabase', 'demo', 'seed.sql'), 'utf8');
const AD = readFileSync(join(root, 'supabase', 'seed', 'american-dream.sql'), 'utf8');
const ORG = 'de000000-0000-4000-8000-000000000001';
let db: PGlite;
let privacy = '';
const uid = async (email: string) => (await rows<{ id: string }>(db, 'select id from auth.users where email = $1', [email]))[0]!.id;
const course = async (code: string) => (await rows<{ id: string }>(db, 'select id from public.courses where organization_id = $1 and site_code = $2', [ORG, code]))[0]!.id;
const branch = async (num: number) => (await rows<{ id: string }>(db, 'select id from public.branches where organization_id = $1 and site_number = $2', [ORG, num]))[0]!.id;

beforeAll(async () => {
  db = await createMigratedDb();
  for (const u of DEMO_USERS) await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2)', [u.email, { full_name: u.name }]);
  await db.exec(SEED);
  await db.exec(AD);
  privacy = (await rows<{ v: string }>(db, `select app.current_legal_version($1, 'privacy') as v`, [ORG]))[0]!.v;
}, 120_000);

describe('American Dream data', () => {
  it('loads branches, courses and offerings from the brief, and is safe to run again', async () => {
    const snapshot = async () => ({
      branches: await count(db, 'select 1 from public.branches where organization_id = $1', [ORG]),
      courses: await count(db, 'select 1 from public.courses where organization_id = $1', [ORG]),
      offerings: await count(db, 'select 1 from public.branch_courses where organization_id = $1', [ORG]),
    });
    const first = await snapshot();
    expect(first).toEqual({ branches: 5, courses: 15, offerings: 31 }); // 12 + 6 + 3 + 6 + 4
    await db.exec(AD);
    expect(await snapshot()).toEqual(first);
    // Демо-курсы стали курсами брифа (не дубли): занятия, тесты и итоги сохранились.
    expect((await rows<{ title: string }>(db, `select title from public.courses where id = 'de220000-0000-4000-8000-000000000001'`))[0]!.title).toBe('Английский (General)');
    const geo = await rows<{ name: string; whatsapp: string | null }>(db, 'select name, whatsapp from public.branches where organization_id = $1 and site_number = 1', [ORG]);
    expect(geo[0]).toEqual({ name: 'American Dream OSH (Геологородок)', whatsapp: '+996990555504' });
    expect(await count(db, 'select 1 from public.branches where organization_id = $1 and whatsapp is null', [ORG])).toBe(3); // в брифе нет номеров
    expect(await count(db, 'select 1 from public.courses where organization_id = $1 and public_price is null and duration_weeks is null', [ORG])).toBe(13); // цен и сроков в брифе нет
  });

  it('public functions return what the site schemas expect, including courses without a language', async () => {
    const [r] = await as(db, null, (tx) => rows<{ site: unknown; catalog: unknown }>(tx, `select public_site('demo') as site, public_catalog('demo') as catalog`));
    const site = SiteSchema.parse(r!.site);
    const catalog = CatalogSchema.parse(r!.catalog);
    expect(site.name).toBe('American Dream');
    expect(site.branches.map((b) => b.number)).toEqual([1, 2, 3, 4, 5]);
    expect(site.branches[0]!.courseIds).toHaveLength(12);
    const content = parseSiteContent(site.settings);
    expect(content.hero?.lines).toHaveLength(3);
    expect(content.logo).toBe('/brand/american-dream-logo.png');
    expect(content.results).toHaveLength(3);
    expect(content.promos).toHaveLength(1);
    expect(catalog).toHaveLength(15);
    const math = catalog.find((c) => c.title === 'Математика')!;
    expect(math.language).toBeNull();
    expect(math.level).toBeNull();
    expect(math.category).toBe('school');
    expect(math.branchIds).toHaveLength(2);
    expect(catalog.find((c) => c.title === 'Английский для детей')!.ageNote).toBe('5–10 лет');
  });
});

describe('course signup request', () => {
  const submit = (tx: Tx, over: Record<string, unknown> = {}) =>
    tx.query<{ r: { id: string; duplicate: boolean; courseCode: string; branchNumbers: number[] } }>(
      `select public.submit_site_request($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ru', $10, $11) as r`,
      [
        over.slug ?? 'demo',
        over.forChild ?? true,
        over.clientName ?? 'Гульмира',
        'childName' in over ? over.childName : 'Айбек',
        'childAge' in over ? over.childAge : 8,
        over.phone ?? '+996555123456',
        over.course,
        over.branches,
        over.heardFrom ?? 'instagram',
        over.consent ?? privacy,
        over.key ?? 'a'.repeat(64),
      ],
    );

  it('only the server (service role) can submit', async () => {
    const c = await course('IELTS');
    const b = [await branch(1)];
    await expectDenied(as(db, null, (tx) => submit(tx, { course: c, branches: b })), /permission denied/);
    await expectDenied(as(db, await uid('student@example.com'), (tx) => submit(tx, { course: c, branches: b })), /permission denied/);
  });

  it('stores the request in CRM with everything the person entered and returns codes for the school bot', async () => {
    const c = await course('Kids English');
    const b = [await branch(5), await branch(1)];
    const r = (await asService(db, (tx) => submit(tx, { course: c, branches: b, key: '1'.repeat(64) }), { commit: true })).rows[0]!.r;
    expect(r.duplicate).toBe(false);
    expect(r.courseCode).toBe('Kids English');
    expect(r.branchNumbers).toEqual([1, 5]);
    const lead = (await rows<{ for_child: boolean; child_name: string; child_age: number; branch_ids: string[]; heard_from: string; branch_id: string; contact_id: string; message: string }>(db,
      'select for_child, child_name, child_age, branch_ids, heard_from, branch_id, contact_id, message from public.lead_requests where id = $1', [r.id]))[0]!;
    expect(lead).toMatchObject({ for_child: true, child_name: 'Айбек', child_age: 8, heard_from: 'instagram' });
    expect(lead.branch_ids).toHaveLength(2);
    expect(lead.branch_id).toBe(await branch(1));
    expect(lead.message).toContain('Курс: Английский для детей');
    expect(lead.message).toContain('Для ребёнка: Айбек (8)');
    expect(await count(db, `select 1 from public.crm_events where contact_id = $1 and kind = 'request' and body like '%Английский для детей%'`, [lead.contact_id])).toBe(1);
    // Повтор той же заявки — та же запись, без новой пересылки.
    const again = (await asService(db, (tx) => submit(tx, { course: c, branches: b, key: '1'.repeat(64) }), { commit: true })).rows[0]!.r;
    expect(again).toMatchObject({ id: r.id, duplicate: true });
  });

  it('rejects unknown courses and branches, stale consent and missing child data', async () => {
    const c = await course('Coding');
    const b = [await branch(4)];
    const svc = (over: Record<string, unknown>) => asService(db, (tx) => submit(tx, { course: c, branches: b, ...over }));
    await expectDenied(svc({ course: '00000000-0000-4000-8000-000000000000' }), /course not available/);
    await expectDenied(svc({ branches: ['00000000-0000-4000-8000-000000000000'] }), /branch not available/);
    await expectDenied(svc({ branches: [] }), /branch not available/);
    await expectDenied(svc({ consent: '2000-01-01' }), /consent version/);
    await expectDenied(svc({ slug: 'nope' }), /organization not available/);
    await expectDenied(svc({ childName: null }), /child_check/);
    await expectDenied(svc({ heardFrom: 'tiktok' }), /heard_from_check/);
    // Филиал или курс другой школы, курс-черновик — отклоняются, даже вместе с настоящими.
    await db.exec(`
      insert into public.organizations (id, name, slug) values ('f0000000-0000-4000-8000-000000000001', 'Other school', 'other-school') on conflict do nothing;
      insert into public.branches (id, organization_id, name, city) values ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'Other', 'Бишкек') on conflict do nothing;
      insert into public.courses (id, organization_id, title, format, kind, status) values
        ('f2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'Other course', 'offline', 'group', 'published'),
        ('f2000000-0000-4000-8000-000000000002', '${ORG}', 'Draft course', 'offline', 'group', 'draft') on conflict do nothing;`);
    await expectDenied(svc({ branches: [b[0], 'f1000000-0000-4000-8000-000000000001'] }), /branch not available/);
    await expectDenied(svc({ course: 'f2000000-0000-4000-8000-000000000001' }), /course not available/);
    await expectDenied(svc({ course: 'f2000000-0000-4000-8000-000000000002' }), /course not available/);
    // Для себя — без данных ребёнка.
    const r = (await asService(db, (tx) => submit(tx, { course: c, branches: b, forChild: false, childName: null, childAge: null, key: '2'.repeat(64) }))).rows[0]!.r;
    expect(r.duplicate).toBe(false);
  });
});

describe('branch offerings and site settings: who can change them', () => {
  it('members read; only the director with MFA changes; other schools see nothing', async () => {
    const director = await uid('director@example.com');
    const manager = await uid('manager@example.com');
    const student = await uid('student@example.com');
    const add = (tx: Tx) => tx.query('insert into public.branch_courses (organization_id, branch_id, course_id) values ($1, $2, $3)', [ORG, 'de100000-0000-4000-8000-000000000002', 'de220000-0000-4000-8000-000000000001'].map(String));
    expect(await as(db, student, (tx) => count(tx, 'select 1 from public.branch_courses'))).toBe(31);
    expect(await as(db, student, (tx) => count(tx, 'select 1 from public.site_settings'))).toBe(1);
    await expectDenied(as(db, director, (tx) => tx.query('delete from public.branch_courses where organization_id = $1', [ORG])).then(async () => {
      // RLS без MFA: удалять нечего, а не ошибка — проверяем, что ничего не удалилось.
      if ((await count(db, 'select 1 from public.branch_courses where organization_id = $1', [ORG])) !== 31) throw new Error('deleted without MFA');
      throw new Error('row-level security: nothing deleted');
    }));
    await expectDenied(asMfa(db, manager, (tx) => tx.query(`update public.site_settings set content = '{}'::jsonb, updated_by = $1 where organization_id = $2 returning 1`, [manager, ORG]).then((r) => {
      if (r.rows.length === 0) throw new Error('row-level security: not updated');
    })));
    await asMfa(db, director, (tx) => tx.query(`update public.site_settings set content = content || '{"promos": []}'::jsonb, updated_by = $1 where organization_id = $2`, [director, ORG]));
    await expectDenied(asMfa(db, director, (tx) => tx.query(`update public.site_settings set content = '"x"'::jsonb, updated_by = $1 where organization_id = $2`, [director, ORG])), /content_check/);
    await expectDenied(asMfa(db, manager, add));
    await expectDenied(as(db, null, (tx) => tx.query('select 1 from public.site_settings')), /permission denied/);
    // Пользователь без членства в школе не видит её настройки и предложения филиалов.
    await db.query(`insert into auth.users (email) values ('outsider@example.com') on conflict do nothing`);
    const outsider = await uid('outsider@example.com');
    expect(await as(db, outsider, (tx) => count(tx, 'select 1 from public.site_settings'))).toBe(0);
    expect(await as(db, outsider, (tx) => count(tx, 'select 1 from public.branch_courses'))).toBe(0);
  });

  it('creating site settings needs the director with MFA', async () => {
    const director = await uid('director@example.com');
    await db.query('delete from public.site_settings where organization_id = $1', [ORG]);
    const create = (tx: Tx) => tx.query(`insert into public.site_settings (organization_id, content, updated_by) values ($1, '{}'::jsonb, $2)`, [ORG, director]);
    await expectDenied(as(db, director, create));
    await expectDenied(asMfa(db, await uid('manager@example.com'), (tx) =>
      tx.query(`insert into public.site_settings (organization_id, content, updated_by) values ($1, '{}'::jsonb, $2)`, [ORG, director])));
    await asMfa(db, director, create);
  });
});
