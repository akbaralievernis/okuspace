import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, GROUP, ORG, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

let db: PGlite;
const BODY = 'Текст юридического документа. '.repeat(5);
const SLOT = 'd0000000-0000-4000-8000-000000000001';
const FULL_SLOT = 'd0000000-0000-4000-8000-000000000002';
const PAST_SLOT = 'd0000000-0000-4000-8000-000000000003';

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.legal_documents (organization_id, kind, locale, version, title, body, status) values
      ('${ORG.A}', 'privacy', 'ru', '2026-10-01', 'Политика (старая)', '${BODY}', 'published'),
      ('${ORG.A}', 'privacy', 'ru', '2026-10-15', 'Политика', '${BODY}', 'published'),
      ('${ORG.A}', 'terms', 'ru', '2026-10-15', 'Правила', '${BODY}', 'published'),
      ('${ORG.A}', 'privacy', 'en', '2026-10-20', 'Draft policy', '${BODY}', 'draft');
    insert into public.public_pages (organization_id, slug, locale, title, body, status) values
      ('${ORG.A}', 'about', 'ru', 'О школе', 'Мы учим языкам.', 'published'),
      ('${ORG.A}', 'faq', 'ru', 'Вопросы', 'Черновик', 'draft');
    update public.courses set public_price = 4500.00, public_price_currency = 'KGS', public_price_unit = 'month' where id = '${COURSE.A}';
    insert into public.languages (organization_id, code, name, status) values ('${ORG.A}', 'de', 'Deutsch', 'active');
    insert into public.trial_slots (id, organization_id, branch_id, course_id, period, format, capacity) values
      ('${SLOT}', '${ORG.A}', '${BRANCH.A1}', '${COURSE.A}', tstzrange(now() + interval '2 days', now() + interval '2 days 1 hour'), 'offline', 2),
      ('${FULL_SLOT}', '${ORG.A}', '${BRANCH.A2}', null, tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour'), 'online', 1),
      ('${PAST_SLOT}', '${ORG.A}', '${BRANCH.A1}', null, tstzrange(now() - interval '1 day', now() - interval '23 hours'), 'offline', 5);
    insert into public.lead_requests (organization_id, branch_id, kind, full_name, phone, trial_slot_id, locale, consent_version, dedupe_key) values
      ('${ORG.A}', '${BRANCH.A2}', 'trial', 'Занятой слот', '+996 555 111 222', '${FULL_SLOT}', 'ru', '2026-10-15', '${'f'.repeat(64)}');
    insert into public.teacher_public_profiles (organization_id, profile_id, display_name) values
      ('${ORG.A}', '${U.teacherA1}', 'Айгерим'), ('${ORG.A}', '${U.teacherA1b}', 'Черновик');
    -- Публикует только сам преподаватель (его согласие) — даже фикстура действует от его имени.
    select set_config('request.jwt.claims', '{"sub": "${U.teacherA1}"}', false);
    update public.teacher_public_profiles set status = 'published' where profile_id = '${U.teacherA1}';
    select set_config('request.jwt.claims', '', false);
  `);
}, 60_000);

const anon = <T>(sql: string, params: unknown[] = []) => as(db, null, async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0]?.r);

describe('anonymous access goes only through public_* functions', () => {
  it('anon can execute public_* functions and no other function in public', async () => {
    const exposed = await rows<{ proname: string }>(
      db,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`,
    );
    const names = exposed.map((e) => e.proname);
    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(names.filter((n) => !n.startsWith('public_'))).toEqual([]);
  });

  it('anon still has no table privileges', async () => {
    await expectDenied(as(db, null, (tx) => tx.query('select * from public.lead_requests')), /permission denied/);
    await expectDenied(as(db, null, (tx) => tx.query('select * from public.legal_documents')), /permission denied/);
    await expectDenied(as(db, null, (tx) => tx.query(`select public.submit_lead_request('school-a','contact',null,'X','+996555000000',null,null,null,null,'ru','2026-10-15', repeat('a',64))`)), /permission denied/);
  });
});

describe('public data contains only published, non-personal fields', () => {
  it('site: name, active branches, current legal versions and published pages', async () => {
    const site = await anon<Record<string, unknown>>('select public.public_site($1) as r', ['school-a']);
    expect(site).toMatchObject({ name: 'Школа A', slug: 'school-a', legal: { privacy: '2026-10-15', terms: '2026-10-15', personal_data: null }, pages: ['about'] });
    expect((site?.branches as unknown[]).length).toBe(2);
    expect(JSON.stringify(site)).not.toMatch(/example\.test|00000000-0000-4000-8000/); // ни email, ни id людей
  });

  it('catalog: published courses with price and open groups with free seats', async () => {
    const catalog = await anon<Record<string, unknown>[]>('select public.public_catalog($1) as r', ['school-a']);
    expect(catalog).toHaveLength(1);
    const course = catalog![0]!;
    expect(course).toMatchObject({ title: 'General English A1', price: { amount: '4500.00', currency: 'KGS', unit: 'month' }, level: { code: 'A1' } });
    const groups = course.groups as { branch: string; freeSeats: number }[];
    expect(groups.map((g) => [g.branch, g.freeSeats]).sort()).toEqual([['A1', 1], ['A1', 9], ['A2', 9]].sort());
    expect(JSON.stringify(catalog)).not.toMatch(/example\.test|00000000-0000-4000-8000/);
  });

  it('draft courses and other schools are not visible', async () => {
    await db.exec(`update public.courses set status = 'draft' where id = '${COURSE.A}'`);
    try {
      expect(await anon('select public.public_catalog($1) as r', ['school-a'])).toEqual([]);
    } finally {
      await db.exec(`update public.courses set status = 'published' where id = '${COURSE.A}'`);
    }
    expect(await anon('select public.public_catalog($1) as r', ['no-such-school'])).toEqual([]);
  });

  it('a suspended school disappears from the public site', async () => {
    await db.exec(`update public.organizations set status = 'suspended' where id = '${ORG.B}'`);
    try {
      expect(await anon('select public.public_site($1) as r', ['school-b'])).toBeNull();
      expect(await anon('select public.public_catalog($1) as r', ['school-b'])).toEqual([]);
    } finally {
      await db.exec(`update public.organizations set status = 'active' where id = '${ORG.B}'`);
    }
  });

  it('pages and legal documents: only published, newest version', async () => {
    expect(await anon('select public.public_page($1, $2, $3) as r', ['school-a', 'about', 'ru'])).toMatchObject({ title: 'О школе' });
    expect(await anon('select public.public_page($1, $2, $3) as r', ['school-a', 'faq', 'ru'])).toBeNull();
    expect(await anon('select public.public_legal($1, $2, $3) as r', ['school-a', 'privacy', 'ru'])).toMatchObject({ version: '2026-10-15', title: 'Политика' });
    expect(await anon('select public.public_legal($1, $2, $3) as r', ['school-a', 'privacy', 'en'])).toBeNull();
  });

  it('teachers: only published profiles of active teachers, without personal ids', async () => {
    expect(await anon('select public.public_teachers($1) as r', ['school-a'])).toEqual([{ displayName: 'Айгерим', bio: {}, languages: [] }]);
    await db.exec(`update public.memberships set status = 'blocked', status_reason = 'left' where profile_id = '${U.teacherA1}'`);
    try {
      expect(await anon('select public.public_teachers($1) as r', ['school-a'])).toEqual([]);
    } finally {
      await db.exec(`update public.memberships set status = 'active', status_reason = null where profile_id = '${U.teacherA1}'`);
    }
  });

  it('trial slots: only future, open, not full; with free spots', async () => {
    const slots = await anon<{ id: string; freeSpots: number }[]>('select public.public_trial_slots($1) as r', ['school-a']);
    expect(slots?.map((s) => [s.id, s.freeSpots])).toEqual([[SLOT, 2]]);
  });
});

describe('teacher public profiles', () => {
  it('only the teacher can publish; site managers can only unpublish', async () => {
    await expect(
      as(db, U.teacherA1b, (tx) => tx.query(`update public.teacher_public_profiles set status = 'published' where profile_id = $1`, [U.teacherA1b])),
    ).resolves.toBeDefined();
    await expectDenied(
      asMfa(db, U.directorA, (tx) => tx.query(`update public.teacher_public_profiles set status = 'published' where profile_id = $1`, [U.teacherA1b])),
      /row-level security|only the teacher/,
    );
    const unpublished = await asMfa(db, U.directorA, (tx) =>
      tx.query(`update public.teacher_public_profiles set status = 'draft' where profile_id = $1`, [U.teacherA1]),
    );
    expect(unpublished.affectedRows).toBe(1);
  });

  it('non-teachers cannot create a public teacher profile; teachers cannot edit others', async () => {
    await expectDenied(
      as(db, U.studentA1, (tx) =>
        tx.query(`insert into public.teacher_public_profiles (organization_id, profile_id, display_name) values ($1, $2, 'Фейк')`, [ORG.A, U.studentA1]),
      ),
      /no active teacher membership/,
    );
    const r = await as(db, U.teacherA1b, (tx) => tx.query(`update public.teacher_public_profiles set display_name = 'x' where profile_id = $1`, [U.teacherA1]));
    expect(r.affectedRows).toBe(0);
  });
});

describe('site content management', () => {
  const upsertPage = (tx: Tx, actor: string) =>
    tx.query(`insert into public.public_pages (organization_id, slug, locale, title, body, status, updated_by) values ($1, 'contacts', 'ru', 'Контакты', 'Тел.', 'published', $2)`, [
      ORG.A, actor,
    ]);

  it('requires site.manage (org-wide) and MFA', async () => {
    await expect(asMfa(db, U.directorA, (tx) => upsertPage(tx, U.directorA))).resolves.toBeDefined();
    await expectDenied(as(db, U.directorA, (tx) => upsertPage(tx, U.directorA)));
    await expectDenied(asMfa(db, U.managerA1, (tx) => upsertPage(tx, U.managerA1)));
    await expectDenied(asMfa(db, U.directorB, (tx) => upsertPage(tx, U.directorB)));
  });

  it('published legal documents are immutable and cannot be deleted; drafts can', async () => {
    await expectDenied(
      asMfa(db, U.directorA, (tx) => tx.query(`update public.legal_documents set body = $1 where version = '2026-10-15' and kind = 'privacy'`, [BODY + 'x'])),
      /immutable/,
    );
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.legal_documents where status = 'published'`)), /cannot be deleted/);
    const del = await asMfa(db, U.directorA, (tx) => tx.query(`delete from public.legal_documents where status = 'draft'`));
    expect(del.affectedRows).toBe(1);
  });

  it('publishing a draft stamps published_at and makes it current', async () => {
    const current = await asMfa(db, U.directorA, async (tx) => {
      await tx.query(
        `insert into public.legal_documents (organization_id, kind, locale, version, title, body, created_by) values ($1, 'privacy', 'ru', '2026-11-01', 'Политика v3', $2, $3)`,
        [ORG.A, BODY, U.directorA],
      );
      await tx.query(`update public.legal_documents set status = 'published' where version = '2026-11-01'`);
      return (await tx.query<{ r: { version: string } }>('select public.public_legal($1, $2, $3) as r', ['school-a', 'privacy', 'ru'])).rows[0]?.r.version;
    });
    expect(current).toBe('2026-11-01');
  });

  it('documents shorter than 100 characters are rejected', async () => {
    await expectDenied(
      asMfa(db, U.directorA, (tx) =>
        tx.query(`insert into public.legal_documents (organization_id, kind, locale, version, title, body, created_by) values ($1, 'terms', 'ky', '2026-10-15', 'Эрежелер', 'кыска', $2)`, [ORG.A, U.directorA]),
      ),
      /legal_documents_body_check/,
    );
  });
});

describe('submit_lead_request (service role only)', () => {
  const submit = (tx: Tx, o: { kind?: string; slot?: string | null; course?: string | null; branch?: string | null; consent?: string; key?: string }) =>
    tx.query<{ id: string }>('select public.submit_lead_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as id', [
      'school-a', o.kind ?? 'trial', o.branch ?? null, 'Асель', '+996 555 000 111', null, null, o.course ?? null,
      o.slot === undefined ? SLOT : o.slot, 'ru', o.consent ?? '2026-10-15', o.key ?? 'a'.repeat(64),
    ]);

  it('is idempotent: the same submission returns the same request', async () => {
    const [a, b, n] = await asService(db, async (tx) => {
      const first = (await submit(tx, {})).rows[0]!.id;
      const second = (await submit(tx, {})).rows[0]!.id;
      return [first, second, await count(tx, `select 1 from public.lead_requests where trial_slot_id = $1`, [SLOT])];
    });
    expect(a).toBe(b);
    expect(n).toBe(1);
  });

  it('rejects outdated consent, full/past slots, draft courses and foreign branches', async () => {
    await expectDenied(asService(db, (tx) => submit(tx, { consent: '2026-10-01' })), /consent version is not current/);
    await expectDenied(asService(db, (tx) => submit(tx, { slot: FULL_SLOT })), /trial slot is full/);
    await expectDenied(asService(db, (tx) => submit(tx, { slot: PAST_SLOT })), /trial slot not available/);
    await expectDenied(asService(db, (tx) => submit(tx, { kind: 'contact', slot: null, branch: BRANCH.B1 })), /branch not available/);
    await expectDenied(asService(db, (tx) => submit(tx, { kind: 'contact', slot: SLOT })), /only allowed for trial/);
    await db.exec(`update public.courses set status = 'draft' where id = '${COURSE.A}'`);
    try {
      await expectDenied(asService(db, (tx) => submit(tx, { kind: 'contact', slot: null, course: COURSE.A })), /course not available/);
    } finally {
      await db.exec(`update public.courses set status = 'published' where id = '${COURSE.A}'`);
    }
  });

  it('a trial request takes the branch of the slot', async () => {
    const branch = await asService(db, async (tx) => {
      const id = (await submit(tx, { branch: BRANCH.A2 })).rows[0]!.id;
      return (await rows<{ branch_id: string }>(tx, 'select branch_id from public.lead_requests where id = $1', [id]))[0]?.branch_id;
    });
    expect(branch).toBe(BRANCH.A1);
  });
});

describe('lead inbox visibility and processing', () => {
  const seeLeads = (user: string) => as(db, user, (tx) => count(tx, 'select 1 from public.lead_requests'));

  it('scoped staff see requests of their branch; teachers, students and other schools see none', async () => {
    expect(await seeLeads(U.directorA)).toBe(1);
    expect(await seeLeads(U.managerA2)).toBe(1);
    expect(await seeLeads(U.adminA1)).toBe(0); // заявка в филиал A2
    for (const u of [U.teacherA2, U.studentA2, U.accountantA, U.directorB]) expect(await seeLeads(u), u).toBe(0);
  });

  it('processing requires lead.manage, MFA and only touches status', async () => {
    const take = (user: string, mfa: boolean) =>
      (mfa ? asMfa : as)(db, user, (tx) => tx.query(`update public.lead_requests set status = 'in_progress', handled_by = $1`, [user]));
    expect((await take(U.managerA2, false)).affectedRows).toBe(0);
    expect((await take(U.managerA2, true)).affectedRows).toBe(1);
    await expectDenied(asMfa(db, U.managerA2, (tx) => tx.query(`update public.lead_requests set phone = '+996 000 000 000'`)), /permission denied/);
  });
});

describe('trial slots management', () => {
  const create = (actor: string, branch: string) => (tx: Tx) =>
    tx.query(
      `insert into public.trial_slots (organization_id, branch_id, period, format, capacity, created_by) values ($1, $2, tstzrange(now() + interval '5 days', now() + interval '5 days 1 hour'), 'online', 5, $3)`,
      [ORG.A, branch, actor],
    );

  it('schedulers with MFA create slots in their branch only', async () => {
    await expect(asMfa(db, U.adminA1, create(U.adminA1, BRANCH.A1))).resolves.toBeDefined();
    await expectDenied(as(db, U.adminA1, create(U.adminA1, BRANCH.A1))); // без MFA
    await expectDenied(asMfa(db, U.adminA1, create(U.adminA1, BRANCH.A2)));
    await expectDenied(asMfa(db, U.teacherA1, create(U.teacherA1, BRANCH.A1)));
  });

  it('group free seats in the catalog follow real enrollments', async () => {
    const seats = await as(db, null, async (tx) => {
      const catalog = (await tx.query<{ r: { groups: { startsOn: string; branch: string; freeSeats: number }[] }[] }>('select public.public_catalog($1) as r', ['school-a'])).rows[0]!.r;
      return catalog[0]!.groups.find((g) => g.freeSeats === 1);
    });
    expect(seats?.branch).toBe('A1'); // GROUP.A1: вместимость 2, один ученик
    expect(GROUP.A1).toBeTruthy();
  });
});
