import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, GROUP, ORG, U, createSeededDb } from '../db/fixtures';
import { as, asService, count, rows, type Tx } from '../db/harness';

/**
 * Этап 8: заявка с сайта → контакт CRM → пробный урок → предложение → ученик → запись
 * на курс; дубли; история этапов; доступ по филиалам; импорт/экспорт; удаление по запросу.
 */
let db: PGlite;
const BODY = 'Текст юридического документа. '.repeat(5);
const SLOT = 'd1000000-0000-4000-8000-000000000001'; // филиал A1, 2 места
const SLOT_A2 = 'd1000000-0000-4000-8000-000000000002';

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.legal_documents (organization_id, kind, locale, version, title, body, status) values
      ('${ORG.A}', 'privacy', 'ru', '2026-10-15', 'Политика', '${BODY}', 'published');
    insert into public.trial_slots (id, organization_id, branch_id, period, format, capacity) values
      ('${SLOT}', '${ORG.A}', '${BRANCH.A1}', tstzrange(now() + interval '2 days', now() + interval '2 days 1 hour'), 'offline', 2),
      ('${SLOT_A2}', '${ORG.A}', '${BRANCH.A2}', tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour'), 'online', 3);
  `);
}, 60_000);

const switchTo = (tx: Tx, sub: string | null, aal: 'aal1' | 'aal2' = 'aal2') =>
  sub === null
    ? tx.exec('set local role service_role')
    : tx.exec('set local role authenticated').then(() => tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal })]));

/** Заявка с сайта (как её отправляет сервер приложения). */
const submit = (tx: Tx, o: { kind?: 'trial' | 'contact'; phone?: string | null; email?: string | null; key: string; slot?: string; name?: string; message?: string }) =>
  tx
    .query<{ id: string }>('select public.submit_lead_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as id', [
      'school-a', o.kind ?? 'trial', o.kind === 'contact' ? BRANCH.A1 : null, o.name ?? 'Асель', o.phone === undefined ? '+996 555 000 111' : o.phone,
      o.email ?? null, o.message ?? 'Хочу на английский', null, o.kind === 'contact' ? null : (o.slot ?? SLOT), 'ru', '2026-10-15', Buffer.from(o.key).toString('hex').padStart(64, '0'),
    ])
    .then((r) => r.rows[0]!.id);

const contactOf = async (tx: Tx, request: string) =>
  (await rows<{ contact_id: string }>(tx, 'select contact_id from public.lead_requests where id = $1', [request]))[0]!.contact_id;

const newContact = (tx: Tx, o: { phone?: string | null; email?: string | null; branch?: string; name?: string; by?: string } = {}) =>
  tx
    .query<{ id: string }>(
      `insert into public.crm_contacts (organization_id, branch_id, full_name, phone, email, source, created_by) values ($1, $2, $3, $4, $5, 'phone', $6) returning id`,
      [ORG.A, o.branch ?? BRANCH.A1, o.name ?? 'Бакыт', o.phone === undefined ? '0700 123 456' : o.phone, o.email ?? null, o.by ?? U.salesA1],
    )
    .then((r) => r.rows[0]!.id);

describe('website requests flow into the CRM without duplicates', () => {
  it('a trial request creates a contact with a booking; a repeat request of the same person reuses it', async () => {
    const r = await asService(db, async (tx) => {
      const a = await submit(tx, { key: 'a' });
      // Тот же человек, другой формат номера и другая форма — новая заявка, но не новый контакт.
      const b = await submit(tx, { key: 'b', kind: 'contact', phone: '0555-000-111', message: 'Есть ли группы вечером?' });
      // Повторная отправка той же формы — та же заявка.
      const a2 = await submit(tx, { key: 'a' });
      const ca = await contactOf(tx, a);
      return {
        same: ca === (await contactOf(tx, b)) && a === a2,
        contacts: await count(tx, 'select 1 from public.crm_contacts'),
        contact: (await rows(tx, 'select phone, source, stage from public.crm_contacts where id = $1', [ca]))[0],
        events: (await rows<{ kind: string }>(tx, 'select kind from public.crm_events where contact_id = $1 order by id', [ca])).map((e) => e.kind),
        bookings: await count(tx, 'select 1 from public.crm_trial_bookings where contact_id = $1', [ca]),
        free: (await tx.query<{ r: { id: string; freeSpots: number }[] }>(`select public.public_trial_slots('school-a') as r`)).rows[0]!.r.find((s) => s.id === SLOT)?.freeSpots,
      };
    });
    expect(r).toEqual({
      same: true,
      contacts: 1,
      contact: { phone: '+996555000111', source: 'website_trial', stage: 'trial_booked' },
      events: ['created', 'request', 'stage_changed', 'trial_booked', 'request'],
      bookings: 1,
      free: 1, // место занято один раз: заявка и бронь — одно и то же
    });
  });

  it('the same email in another case is the same person', async () => {
    const n = await asService(db, async (tx) => {
      await submit(tx, { key: 'c', kind: 'contact', phone: null, email: 'Aigul@Example.test' });
      await submit(tx, { key: 'd', kind: 'contact', phone: null, email: 'aigul@example.test' });
      return count(tx, 'select 1 from public.crm_contacts');
    });
    expect(n).toBe(1);
  });

  it('manually created contacts cannot duplicate a phone or email in any format', async () => {
    await expectDenied(
      as(db, U.salesA1, async (tx) => {
        await switchTo(tx, U.salesA1);
        await newContact(tx, { phone: '+996 700 123 456' });
        await newContact(tx, { phone: '0700123456' });
      }),
      /crm_contacts_phone_key/,
    );
  });
});

describe('the full sales workflow with history', () => {
  it('request → call → trial → offer → student → enrolment; every step is in the history', async () => {
    const r = await asService(db, async (tx) => {
      const req = await submit(tx, { key: 'e', phone: '+996 777 000 001' });
      const contact = await contactOf(tx, req);
      const booking = (await rows<{ id: string }>(tx, 'select id from public.crm_trial_bookings where contact_id = $1', [contact]))[0]!.id;
      await switchTo(tx, U.salesA1);
      await tx.query(`update public.crm_contacts set owner_id = $2 where id = $1`, [contact, U.salesA1]);
      await tx.query(`insert into public.crm_events (organization_id, contact_id, kind, channel, body, actor_id) values ($1, $2, 'call', 'phone', 'Подтвердила пробный урок', $3)`, [ORG.A, contact, U.salesA1]);
      await tx.query(`insert into public.crm_reminders (organization_id, contact_id, assignee_id, due_at, note, created_by) values ($1, $2, $3, now() + interval '1 day', 'Перезвонить после урока', $3)`, [ORG.A, contact, U.salesA1]);
      await tx.query('select public.crm_trial_result($1, $2)', [booking, 'attended']);
      await tx.query(`update public.crm_contacts set stage = 'offer' where id = $1`, [contact]);
      await tx.query('select public.crm_convert($1, $2)', [contact, U.studentA1b]);
      // Менеджер по продажам записывает на курс (enrollment.manage в его роли); повторная запись не проходит.
      await tx.query('select public.crm_enroll($1, $2)', [contact, GROUP.A1]);
      let again = '';
      await tx.exec('savepoint s');
      try {
        await tx.query('select public.crm_enroll($1, $2)', [contact, GROUP.A1]);
      } catch (e) {
        again = (e as Error).message;
        await tx.exec('rollback to savepoint s');
      }
      return {
        again,
        contact: (await rows(tx, 'select stage, profile_id, owner_id from public.crm_contacts where id = $1', [contact]))[0],
        history: await rows(tx, 'select kind, from_stage, to_stage from public.crm_events where contact_id = $1 order by id', [contact]),
        enrolled: await count(tx, 'select 1 from public.enrollments where group_id = $1 and student_id = $2', [GROUP.A1, U.studentA1b]),
      };
    });
    expect(r.again).toMatch(/group is full|duplicate key/);
    expect(r.contact).toEqual({ stage: 'won', profile_id: U.studentA1b, owner_id: U.salesA1 });
    expect(r.enrolled).toBe(1);
    expect(r.history).toEqual([
      { kind: 'created', from_stage: null, to_stage: 'new' },
      { kind: 'request', from_stage: null, to_stage: null },
      { kind: 'stage_changed', from_stage: 'new', to_stage: 'trial_booked' },
      { kind: 'trial_booked', from_stage: null, to_stage: null },
      { kind: 'assigned', from_stage: null, to_stage: null },
      { kind: 'call', from_stage: null, to_stage: null },
      { kind: 'stage_changed', from_stage: 'trial_booked', to_stage: 'trial_done' },
      { kind: 'trial_result', from_stage: null, to_stage: null },
      { kind: 'stage_changed', from_stage: 'trial_done', to_stage: 'offer' },
      { kind: 'stage_changed', from_stage: 'offer', to_stage: 'won' },
      { kind: 'converted', from_stage: null, to_stage: null },
      { kind: 'enrolled', from_stage: null, to_stage: null },
    ]);
  });

  it('“student” only through conversion; lost needs a reason; history and conversion cannot be forged', async () => {
    const attempts = await as(db, U.salesA1, async (tx) => {
      await switchTo(tx, U.salesA1);
      const c = await newContact(tx);
      const out: string[] = [];
      for (const sql of [
        `update public.crm_contacts set stage = 'won' where id = $1`,
        `update public.crm_contacts set stage = 'lost' where id = $1`,
        `update public.crm_contacts set profile_id = '${U.studentA1b}' where id = $1`,
        `insert into public.crm_events (organization_id, contact_id, kind, from_stage, to_stage, actor_id) values ('${ORG.A}', $1, 'stage_changed', 'new', 'won', '${U.salesA1}')`,
        `insert into public.crm_events (organization_id, contact_id, kind, body, actor_id) values ('${ORG.A}', $1, 'call', 'x', '${U.adminA1}')`,
        `update public.crm_events set body = 'rewritten' where contact_id = $1`,
        `delete from public.crm_contacts where id = $1`,
      ]) {
        await tx.exec('savepoint s');
        try {
          await tx.query(sql, [c]);
          out.push('allowed');
        } catch (e) {
          out.push((e as Error).message);
          await tx.exec('rollback to savepoint s');
        }
      }
      return out;
    });
    expect(attempts[0]).toMatch(/crm_contacts_won_check/);
    expect(attempts[1]).toMatch(/crm_contacts_lost_check/);
    expect(attempts[2]).toMatch(/permission denied/);
    expect(attempts[3]).toMatch(/row-level security/);
    expect(attempts[4]).toMatch(/row-level security/);
    expect(attempts[5]).toMatch(/permission denied|append-only/);
    expect(attempts[6]).toMatch(/permission denied/);
  });

  it('conversion needs a student of the branch; the manager must be a sales employee of the branch', async () => {
    for (const [profile, re] of [
      [U.teacherA1, /not a student/],
      [U.studentA2, /not a student/], // ученик другого филиала
      [U.studentB, /not a student/],
    ] as const) {
      await expectDenied(
        as(db, U.salesA1, async (tx) => {
          await switchTo(tx, U.salesA1);
          await tx.query('select public.crm_convert($1, $2)', [await newContact(tx), profile]);
        }),
        re,
      );
    }
    for (const owner of [U.teacherA1, U.accountantA, U.managerA2]) {
      await expectDenied(
        as(db, U.salesA1, async (tx) => {
          await switchTo(tx, U.salesA1);
          await tx.query('update public.crm_contacts set owner_id = $2 where id = $1', [await newContact(tx), owner]);
        }),
        /owner must be a sales employee/,
      );
    }
  });
});

describe('access is checked on the server', () => {
  it('only sales staff of the branch see contacts, history and reminders', async () => {
    const seen = await asService(db, async (tx) => {
      await submit(tx, { key: 'f', phone: '+996 777 000 002' }); // филиал A1
      await submit(tx, { key: 'g', phone: '+996 777 000 003', slot: SLOT_A2 }); // филиал A2
      const out: Record<string, number> = {};
      for (const user of [U.salesA1, U.adminA1, U.managerA1, U.managerA2, U.directorA, U.teacherA1, U.accountantA, U.studentA1, U.directorB]) {
        await switchTo(tx, user);
        out[user] = await count(tx, 'select 1 from public.crm_contacts');
        out[`${user}:events`] = await count(tx, 'select 1 from public.crm_events');
      }
      return out;
    });
    for (const u of [U.salesA1, U.adminA1, U.managerA1, U.managerA2]) expect(seen[u], u).toBe(1);
    expect(seen[U.directorA]).toBe(2);
    for (const u of [U.teacherA1, U.accountantA, U.studentA1, U.directorB]) {
      expect(seen[u], u).toBe(0);
      expect(seen[`${u}:events`], u).toBe(0);
    }
  });

  it('changes need lead.manage with MFA in the contact branch', async () => {
    await expectDenied(
      as(db, U.salesA1, async (tx) => {
        await switchTo(tx, U.salesA1, 'aal1');
        await newContact(tx);
      }),
    );
    const affected = await as(db, U.salesA1, async (tx) => {
      await switchTo(tx, U.salesA1);
      const c = await newContact(tx);
      const out: Record<string, number> = {};
      for (const user of [U.managerA2, U.teacherA1, U.accountantA]) {
        await switchTo(tx, user);
        out[user] = (await tx.query(`update public.crm_contacts set note = 'x' where id = $1`, [c])).affectedRows ?? 0;
      }
      return out;
    });
    expect(affected).toEqual({ [U.managerA2]: 0, [U.teacherA1]: 0, [U.accountantA]: 0 });
  });
});

describe('import and export', () => {
  it('import skips duplicates (in the database and inside the file) and invalid rows', async () => {
    const r = await as(db, U.salesA1, async (tx) => {
      await switchTo(tx, U.salesA1);
      await newContact(tx, { phone: '0700 999 001' });
      const rows = [
        { fullName: 'Нурлан', phone: '+996 700 999 001' }, // уже есть
        { fullName: 'Айжан', phone: '0700 999 002', note: 'Из Instagram' },
        { fullName: 'Айжан повтор', phone: '+996700999002' }, // дубль внутри файла
        { fullName: '', phone: '0700 999 003' }, // без имени
        { fullName: 'Без контактов' },
        { fullName: 'Мээрим', email: 'meerim@example.test' },
      ];
      const res = (await tx.query<{ r: object }>('select public.crm_import($1, $2, $3) as r', [ORG.A, BRANCH.A1, JSON.stringify(rows)])).rows[0]!.r;
      return { res, imported: await count(tx, `select 1 from public.crm_events where kind = 'imported'`) };
    });
    expect(r).toEqual({ res: { created: 2, duplicates: [1, 3], invalid: [4, 5] }, imported: 2 });
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query('select public.crm_import($1, $2, $3)', [ORG.A, BRANCH.A1, '[{"fullName":"x","phone":"0700000000"}]'])), /not allowed/);
  });

  it('export: crm.admin with MFA only, own branch only, minimal fields, every export logged', async () => {
    const r = await asService(db, async (tx) => {
      await submit(tx, { key: 'h', phone: '+996 777 000 004', message: 'Личное сообщение' }); // A1
      await submit(tx, { key: 'i', phone: '+996 777 000 005', slot: SLOT_A2 }); // A2
      await switchTo(tx, U.managerA1);
      const branch = (await tx.query<{ r: Record<string, unknown>[] }>('select public.crm_export($1) as r', [ORG.A])).rows[0]!.r;
      await switchTo(tx, U.directorA);
      const all = (await tx.query<{ r: Record<string, unknown>[] }>('select public.crm_export($1) as r', [ORG.A])).rows[0]!.r;
      const log = await rows(tx, 'select actor_id, row_count from public.crm_exports order by id');
      return { branch, all, log };
    });
    expect(r.branch).toHaveLength(1);
    expect(r.all).toHaveLength(2);
    expect(Object.keys(r.branch[0]!).sort()).toEqual(['branch', 'createdAt', 'email', 'fullName', 'lastActivityAt', 'owner', 'phone', 'source', 'stage']);
    expect(JSON.stringify(r.all)).not.toContain('Личное сообщение');
    expect(r.log).toEqual([
      { actor_id: U.managerA1, row_count: 1 },
      { actor_id: U.directorA, row_count: 2 },
    ]);
    for (const [user, aal] of [
      [U.salesA1, 'aal2'],
      [U.adminA1, 'aal2'],
      [U.managerA1, 'aal1'],
      [U.directorB, 'aal2'],
    ] as const) {
      await expectDenied(
        as(db, user, async (tx) => {
          await switchTo(tx, user, aal);
          await tx.query('select public.crm_export($1)', [ORG.A]);
        }),
        /not allowed/,
      );
    }
  });
});

describe('deletion on request and retention', () => {
  it('erasing removes personal data from the contact, history, reminders and website requests', async () => {
    const r = await asService(db, async (tx) => {
      const req = await submit(tx, { key: 'j', phone: '+996 777 000 006', email: 'erase@example.test', message: 'Мой адрес ул. Ленина 1' });
      const c = await contactOf(tx, req);
      await switchTo(tx, U.salesA1);
      await tx.query(`insert into public.crm_reminders (organization_id, contact_id, assignee_id, due_at, note, created_by) values ($1, $2, $3, now() + interval '1 day', 'Позвонить маме', $3)`, [ORG.A, c, U.salesA1]);
      let salesErase = '';
      await tx.exec('savepoint s');
      try {
        await tx.query('select public.crm_erase($1, $2)', [c, 'request by phone']);
      } catch (e) {
        salesErase = (e as Error).message;
        await tx.exec('rollback to savepoint s');
      }
      await switchTo(tx, U.managerA1);
      await tx.query('select public.crm_erase($1, $2)', [c, 'request by phone']);
      await switchTo(tx, null);
      const dump = JSON.stringify([
        await rows(tx, 'select * from public.crm_contacts where id = $1', [c]),
        await rows(tx, 'select * from public.crm_events where contact_id = $1', [c]),
        await rows(tx, 'select * from public.crm_reminders where contact_id = $1', [c]),
      ]);
      return {
        salesErase,
        dump,
        requests: await count(tx, 'select 1 from public.lead_requests where id = $1', [req]),
        lastEvent: (await rows<{ kind: string; body: string }>(tx, 'select kind, body from public.crm_events where contact_id = $1 order by id desc limit 1', [c]))[0],
        reminder: (await rows(tx, 'select status from public.crm_reminders where contact_id = $1', [c]))[0],
        // Тот же человек может снова оставить заявку — это будет новый контакт.
        again: await submit(tx, { key: 'k', phone: '+996 777 000 006' }).then((id) => contactOf(tx, id)).then((id) => id !== c),
      };
    });
    expect(r.salesErase).toMatch(/not available/);
    for (const pii of ['777000006', 'erase@example.test', 'Ленина', 'Асель', 'Позвонить маме']) expect(r.dump).not.toContain(pii);
    expect(r.requests).toBe(0);
    expect(r.lastEvent).toEqual({ kind: 'erased', body: 'request by phone' });
    expect(r.reminder).toEqual({ status: 'cancelled' });
    expect(r.again).toBe(true);
  });

  it('erased contacts cannot be edited; erasing needs a reason', async () => {
    await expectDenied(
      as(db, U.managerA1, async (tx) => {
        await switchTo(tx, U.salesA1);
        const c = await newContact(tx);
        await switchTo(tx, U.managerA1);
        await tx.query('select public.crm_erase($1, $2)', [c, '']);
      }),
      /a reason is required/,
    );
    const affected = await as(db, U.managerA1, async (tx) => {
      await switchTo(tx, U.salesA1);
      const c = await newContact(tx);
      await switchTo(tx, U.managerA1);
      await tx.query('select public.crm_erase($1, $2)', [c, 'asked by email']);
      return (await tx.query(`update public.crm_contacts set full_name = 'Восстановлен' where id = $1`, [c])).affectedRows;
    });
    expect(affected).toBe(0);
  });

  it('retention: stale unconverted contacts are anonymised by the scheduled job; students are kept', async () => {
    const r = await asService(db, async (tx) => {
      await switchTo(tx, U.salesA1);
      const stale = await newContact(tx, { phone: '0700 888 001' });
      const fresh = await newContact(tx, { phone: '0700 888 002' });
      const won = await newContact(tx, { phone: '0700 888 003' });
      await tx.query('select public.crm_convert($1, $2)', [won, U.studentA1]);
      await switchTo(tx, null);
      await tx.query(`update public.crm_contacts set last_activity_at = now() - interval '30 months' where id in ($1, $2)`, [stale, won]);
      const purged = (await tx.query<{ n: number }>('select public.crm_purge_stale(24) as n')).rows[0]!.n;
      const state = await rows<{ id: string; erased: boolean }>(tx, 'select id, erased_at is not null as erased from public.crm_contacts where id in ($1, $2, $3)', [stale, fresh, won]);
      return { purged, state: Object.fromEntries(state.map((s) => [s.id === stale ? 'stale' : s.id === fresh ? 'fresh' : 'won', s.erased])) };
    });
    expect(r).toEqual({ purged: 1, state: { stale: true, fresh: false, won: false } });
    await expectDenied(as(db, U.directorA, (tx) => tx.query('select public.crm_purge_stale(24)')), /permission denied/);
  });
});

describe('trial capacity is shared between the website and the CRM', () => {
  it('a CRM booking takes a place; when the slot is full the website refuses', async () => {
    const r = await asService(db, async (tx) => {
      await switchTo(tx, U.salesA1);
      const a = await newContact(tx, { phone: '0700 777 001' });
      const b = await newContact(tx, { phone: '0700 777 002' });
      await tx.query('select public.crm_book_trial($1, $2)', [a, SLOT]);
      await tx.query('select public.crm_book_trial($1, $2)', [b, SLOT]);
      await switchTo(tx, null);
      let site = '';
      try {
        await submit(tx, { key: 'm', phone: '+996 777 000 009' });
      } catch (e) {
        site = (e as Error).message;
      }
      return site;
    });
    expect(r).toMatch(/trial slot is full/);
  });
});

describe('funnel', () => {
  it('counts contacts by stage and source within the caller scope', async () => {
    const f = await asService(db, async (tx) => {
      await submit(tx, { key: 'n', phone: '+996 777 000 010' });
      await submit(tx, { key: 'o', phone: '+996 777 000 011', slot: SLOT_A2 });
      await switchTo(tx, U.salesA1);
      const c = await newContact(tx);
      await tx.query('select public.crm_convert($1, $2)', [c, U.studentA1b]);
      const sales = (await tx.query<{ r: object }>(`select public.crm_funnel($1, now() - interval '1 day', now() + interval '1 day') as r`, [ORG.A])).rows[0]!.r;
      await switchTo(tx, U.directorA);
      const director = (await tx.query<{ r: { total: number } }>(`select public.crm_funnel($1, now() - interval '1 day', now() + interval '1 day') as r`, [ORG.A])).rows[0]!.r;
      return { sales, director: director.total };
    });
    expect(f.sales).toEqual({
      total: 2,
      won: 1,
      byStage: { trial_booked: 1, won: 1 },
      bySource: { phone: { total: 1, won: 1 }, website_trial: { total: 1, won: 0 } },
    });
    expect(f.director).toBe(3);
  });
});

describe('phone normalisation', () => {
  it('turns local and international formats into one canonical number', async () => {
    const r = await asService(db, (tx) =>
      rows<{ a: string; b: string; c: string; d: string; e: string | null }>(
        tx,
        `select app.normalize_phone('0555 12-34-56') as a, app.normalize_phone('+996 (555) 123 456') as b, app.normalize_phone('996555123456') as c,
                app.normalize_phone('+7 701 123 45 67') as d, app.normalize_phone('  ') as e`,
      ),
    );
    expect(r[0]).toEqual({ a: '+996555123456', b: '+996555123456', c: '+996555123456', d: '+77011234567', e: null });
  });
});
