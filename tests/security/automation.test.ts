import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

/**
 * Блок C: счета за месяц по записям и тарифам, зарплата по проведённым занятиям,
 * отработки пропусков, замена преподавателя (с доступом только в окне занятия).
 */
let db: PGlite;
const MONTH = '2026-11-01';
const COURSE2 = 'e4000000-0000-4000-8000-000000000001'; // курс без тарифа
const GROUP2 = 'e4000000-0000-4000-8000-000000000002';
const id = (n: number) => `e4000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const nov = (day: number, h = 6) => `2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    -- Прайс школы (6000) и прайс филиала A2 (5500) на курс A, помесячно.
    insert into public.price_lists (id, organization_id, name, valid_from, status, created_by) values
      ('${id(1)}', '${ORG.A}', 'Прайс школы', '2026-01-01', 'active', '${U.directorA}');
    insert into public.price_lists (id, organization_id, branch_id, name, valid_from, status, created_by) values
      ('${id(2)}', '${ORG.A}', '${BRANCH.A2}', 'Прайс Оша', '2026-01-01', 'active', '${U.directorA}');
    insert into public.tariffs (organization_id, price_list_id, course_id, name, unit, amount) values
      ('${ORG.A}', '${id(1)}', '${COURSE.A}', 'Месяц', 'month', 6000),
      ('${ORG.A}', '${id(2)}', '${COURSE.A}', 'Месяц (Ош)', 'month', 5500);
    insert into public.courses (id, organization_id, title, format, kind, status) values ('${COURSE2}', '${ORG.A}', 'Math', 'offline', 'group', 'published');
    insert into public.groups (id, organization_id, branch_id, course_id, name, capacity, starts_on) values
      ('${GROUP2}', '${ORG.A}', '${BRANCH.A1}', '${COURSE2}', 'MATH-1', 10, '2026-11-01');
    insert into public.enrollments (organization_id, branch_id, group_id, student_id, status) values ('${ORG.A}', '${BRANCH.A1}', '${GROUP2}', '${U.studentA1b}', 'active');

    -- Проведённые занятия ноября: teacherA1 — 3 (A1), teacherA2 — 2 (A2); отменённое не считается.
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period, status) values
      ('${id(11)}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${nov(3)}', '${nov(3, 7)}'), 'done'),
      ('${id(12)}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${nov(10)}', '${nov(10, 7)}'), 'done'),
      ('${id(13)}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${nov(20)}', '${nov(20, 7)}'), 'done'),
      ('${id(14)}', '${ORG.A}', '${BRANCH.A2}', '${GROUP.A2}', '${U.teacherA2}', '${ROOM.A2}', tstzrange('${nov(4)}', '${nov(4, 7)}'), 'done'),
      ('${id(15)}', '${ORG.A}', '${BRANCH.A2}', '${GROUP.A2}', '${U.teacherA2}', '${ROOM.A2}', tstzrange('${nov(5)}', '${nov(5, 7)}'), 'done');
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period, status, cancel_reason) values
      ('${id(16)}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${nov(6)}', '${nov(6, 7)}'), 'cancelled', 'Праздник');
  `);
}, 60_000);

const notes = (u: string, kind: string) => count(db, 'select 1 from public.notifications where recipient_id = $1 and kind = $2', [u, kind]);

describe('monthly invoices from enrollments and tariffs', () => {
  const generate = (tx: Tx) => tx.query<{ r: { created: number; existing: number; noTariff: unknown[] } }>('select public.billing_generate($1, $2) as r', [ORG.A, MONTH]);

  it('needs MFA and finance.write', async () => {
    await expectDenied(as(db, U.accountantA, generate), /mfa required/);
    for (const u of [U.teacherA1, U.managerA1, U.directorA, U.studentA1, U.directorB]) await expectDenied(asMfa(db, u, generate), /not allowed/);
  });

  it('creates one draft per active enrollment at the right price, numbered, without duplicates', async () => {
    const r = (await asMfa(db, U.accountantA, generate, { commit: true })).rows[0]!.r;
    expect(r.created).toBe(3);
    expect(r.noTariff).toHaveLength(1); // Math без тарифа — в списке, счёта нет
    const inv = await rows<{ number: string; payer_id: string; total: string; status: string; due_on: string; branch_id: string }>(db,
      `select number, payer_id, total::text, status, due_on::text, branch_id from public.invoices where billing_month = $1 order by number`, [MONTH]);
    expect(inv.map((i) => i.number)).toEqual(['M2611-0001', 'M2611-0002', 'M2611-0003']);
    expect(inv.every((i) => i.status === 'draft' && i.due_on === '2026-11-10')).toBe(true);
    const byStudent = Object.fromEntries(inv.map((i) => [i.payer_id, i.total]));
    expect(byStudent[U.studentA1]).toBe('6000.00');
    expect(byStudent[U.studentA1b]).toBe('6000.00');
    expect(byStudent[U.studentA2]).toBe('5500.00'); // прайс филиала важнее прайса школы
    const again = (await asMfa(db, U.accountantA, generate, { commit: true })).rows[0]!.r;
    expect(again).toMatchObject({ created: 0, existing: 3 });
  });

  it('issues the month; an invoice with a pending discount stays a draft', async () => {
    const a1 = (await rows<{ id: string }>(db, `select id from public.invoices where billing_month = $1 and payer_id = $2`, [MONTH, U.studentA1]))[0]!.id;
    await asMfa(db, U.accountantA, (tx) =>
      tx.query(`insert into public.invoice_adjustments (organization_id, branch_id, invoice_id, kind, amount, reason, requested_by) values ($1, $2, $3, 'discount', 500, 'Скидка за друга', $4)`,
        [ORG.A, BRANCH.A1, a1, U.accountantA]), { commit: true });
    const r = (await asMfa(db, U.accountantA, (tx) => tx.query<{ r: { issued: number; failed: { invoiceId: string; reason: string }[] } }>('select public.billing_issue($1, $2) as r', [ORG.A, MONTH]), { commit: true })).rows[0]!.r;
    expect(r.issued).toBe(2);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ invoiceId: a1 });
    expect(r.failed[0]!.reason).toMatch(/pending discounts/);
  });

  it('an accountant of one branch bills only that branch', async () => {
    const acc = (await rows<{ id: string }>(db, `insert into auth.users (email) values ('acc-a1@example.test') returning id`))[0]!.id;
    await db.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, 'accountant')`, [ORG.A, BRANCH.A1, acc]);
    const r = (await asMfa(db, acc, (tx) => tx.query<{ r: { created: number; existing: number } }>('select public.billing_generate($1, $2) as r', [ORG.A, '2026-12-01']))).rows[0]!.r;
    expect(r.created).toBe(2); // studentA1 и studentA1b в A1; Ош (A2) — не его филиал
  });

  it('a voided invoice can be generated again; nothing else is duplicated', async () => {
    const a2 = (await rows<{ id: string }>(db, `select id from public.invoices where billing_month = $1 and payer_id = $2`, [MONTH, U.studentA2]))[0]!.id;
    await asMfa(db, U.accountantA, (tx) => tx.query(`update public.invoices set status = 'void', void_reason = 'Ошибка в группе' where id = $1`, [a2]), { commit: true });
    const r = (await asMfa(db, U.accountantA, generate, { commit: true })).rows[0]!.r;
    expect(r).toMatchObject({ created: 1, existing: 2 });
    expect(await count(db, `select 1 from public.invoices where billing_month = $1 and payer_id = $2 and status <> 'void'`, [MONTH, U.studentA2])).toBe(1);
    await expectDenied(asService(db, (tx) =>
      tx.query(`insert into public.invoices (organization_id, branch_id, payer_id, number, total, created_by, enrollment_id, billing_month)
                select organization_id, branch_id, payer_id, 'DUP-1', 0, created_by, enrollment_id, billing_month from public.invoices where billing_month = $1 and status <> 'void' limit 1`, [MONTH])), /enrollment_month_key/);
  });
});

describe('teacher payroll per held lesson', () => {
  const rate = (tx: Tx, teacher: string, amount: number, from: string, branch: string | null = null) =>
    tx.query('insert into public.teacher_rates (organization_id, branch_id, teacher_id, amount, valid_from, created_by) values ($1, $2, $3, $4, $5, $6)',
      [ORG.A, branch, teacher, amount, from, U.accountantA]);
  const generate = (tx: Tx) => tx.query<{ r: { statements: number; noRate: { teacherId: string; sessions: number }[] } }>('select public.payroll_generate($1, $2) as r', [ORG.A, MONTH]);
  const statement = async () => (await rows<{ id: string; sessions: number; amount: string; status: string; generated_by: string }>(db,
    `select id, sessions, amount::text, status, generated_by from public.payroll_statements where teacher_id = $1 and month = $2`, [U.teacherA1, MONTH]))[0]!;

  it('rates: finance staff with MFA, only for active teachers, append-only', async () => {
    await asMfa(db, U.accountantA, (tx) => rate(tx, U.teacherA1, 500, '2026-01-01'), { commit: true });
    await asMfa(db, U.accountantA, (tx) => rate(tx, U.teacherA1, 700, '2026-11-15', BRANCH.A1), { commit: true });
    await expectDenied(as(db, U.accountantA, (tx) => rate(tx, U.teacherA1, 900, '2026-12-01')));
    await expectDenied(asMfa(db, U.teacherA1, (tx) => rate(tx, U.teacherA1, 9000, '2026-12-01')));
    await expectDenied(asMfa(db, U.accountantA, (tx) => rate(tx, U.studentA1, 100, '2026-12-01')), /active teacher/);
    await expectDenied(asService(db, (tx) => tx.query('update public.teacher_rates set amount = 1')), /append-only/);
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.teacher_rates'))).toBe(2); // свои ставки видит
    expect(await as(db, U.teacherA2, (tx) => count(tx, 'select 1 from public.teacher_rates'))).toBe(0);
  });

  it('counts held lessons at the rate in force on each day; teachers without a rate are listed', async () => {
    const r = (await asMfa(db, U.accountantA, generate, { commit: true })).rows[0]!.r;
    expect(r.statements).toBe(1);
    expect(r.noRate).toEqual([{ teacherId: U.teacherA2, branchId: BRANCH.A2, sessions: 2 }]);
    const s = await statement();
    expect(s).toMatchObject({ sessions: 3, amount: '1700.00', status: 'draft', generated_by: U.accountantA }); // 500 + 500 + 700 (с 15-го — ставка филиала)
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.payroll_statements'))).toBe(0); // черновик учителю не виден
    await expectDenied(as(db, U.accountantA, generate), /mfa required/);
    await expectDenied(asMfa(db, U.directorA, generate), /not allowed/); // нет finance.write
  });

  it('approval by another person with finance.approve; then the statement is frozen', async () => {
    const s = await statement();
    const approve = (tx: Tx) => tx.query('select public.payroll_approve($1)', [s.id]);
    await expectDenied(asMfa(db, U.accountantA, approve), /not allowed/);
    await expectDenied(asMfa(db, U.teacherA1, approve), /not allowed/);
    await expectDenied(as(db, U.managerA1, approve), /not allowed/);
    await asMfa(db, U.managerA1, approve, { commit: true });
    expect((await statement()).status).toBe('approved');
    expect(await notes(U.teacherA1, 'payroll_approved')).toBe(1);
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.payroll_statements'))).toBe(1);
    // Новое занятие после утверждения не меняет утверждённую ведомость.
    await db.exec(`insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period, status) values
      ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${nov(25)}', '${nov(25, 7)}'), 'done')`);
    await asMfa(db, U.accountantA, generate, { commit: true });
    expect(await statement()).toMatchObject({ sessions: 3, amount: '1700.00' });
    await expectDenied(asService(db, (tx) => tx.query(`update public.payroll_statements set amount = 1 where id = $1`, [s.id])), /immutable/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.payroll_statements where id = $1`, [s.id])), /not deleted/);
    await expectDenied(asService(db, (tx) => tx.query(`update public.payroll_statements set approved_by = generated_by where id = $1`, [s.id])), /four_eyes/);
  });

  it('the author of a statement cannot approve it, even with both rights', async () => {
    const both = (await rows<{ id: string }>(db, `insert into auth.users (email) values ('both-a2@example.test') returning id`))[0]!.id;
    await db.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, 'accountant'), ($1, $2, $3, 'branch_manager')`, [ORG.A, BRANCH.A2, both]);
    await asMfa(db, U.accountantA, (tx) => tx.query(`insert into public.teacher_rates (organization_id, teacher_id, amount, valid_from, created_by) values ($1, $2, 400, '2026-01-01', $3)`, [ORG.A, U.teacherA2, U.accountantA]), { commit: true });
    await asMfa(db, both, (tx) => tx.query('select public.payroll_generate($1, $2)', [ORG.A, MONTH]), { commit: true });
    const st = (await rows<{ id: string; generated_by: string }>(db, `select id, generated_by from public.payroll_statements where teacher_id = $1 and month = $2`, [U.teacherA2, MONTH]))[0]!;
    expect(st.generated_by).toBe(both);
    await expectDenied(asMfa(db, both, (tx) => tx.query('select public.payroll_approve($1)', [st.id])), /approver must differ|four_eyes/);
  });

  it('payment creates a salary expense once', async () => {
    const s = await statement();
    const pay = (tx: Tx) => tx.query<{ e: string }>('select public.payroll_pay($1) as e', [s.id]);
    await expectDenied(asMfa(db, U.managerA1, pay), /not allowed/);
    const expense = (await asMfa(db, U.accountantA, pay, { commit: true })).rows[0]!.e;
    const e = (await rows<{ category: string; amount: string; branch_id: string }>(db, 'select category, amount::text, branch_id from public.expenses where id = $1', [expense]))[0]!;
    expect(e).toEqual({ category: 'salary', amount: '1700.00', branch_id: BRANCH.A1 });
    expect((await statement()).status).toBe('paid');
    await expectDenied(asMfa(db, U.accountantA, pay), /invalid transition/);
  });
});

describe('make-up lessons after absences', () => {
  const FUTURE = 'e4000000-0000-4000-8000-000000000201';
  const mark = (student: string, status: string, session = id(12)) =>
    db.query(`insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source, marked_by) values ($1, $2, $3, $4, $5, 'teacher', $6)
              on conflict (session_id, student_id) do update set status = excluded.status`, [ORG.A, BRANCH.A1, session, student, status, U.teacherA1]);
  const req = async (student: string, session = id(12)) =>
    (await rows<{ id: string; status: string }>(db, 'select id, status from public.makeup_requests where student_id = $1 and missed_session_id = $2', [student, session]))[0];

  beforeAll(async () => {
    await db.query(`insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period) values
      ($1, $2, $3, $4, $5, $6, tstzrange(now() + interval '3 days', now() + interval '3 days 90 minutes'))`, [FUTURE, ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1b, ROOM.A1x]);
  });

  it('an absence opens a request automatically; correcting to present closes it', async () => {
    await mark(U.studentA1, 'absent');
    expect((await req(U.studentA1))?.status).toBe('open');
    await mark(U.studentA1, 'present');
    expect((await req(U.studentA1))?.status).toBe('cancelled');
    await mark(U.studentA1, 'excused');
    expect((await req(U.studentA1))?.status).toBe('open');
    await mark(U.studentA1b, 'present', id(13));
    expect(await req(U.studentA1b, id(13))).toBeUndefined();
  });

  it('branch staff schedule it into an upcoming session; the student and guardians are told', async () => {
    const r = (await req(U.studentA1))!;
    const schedule = (u: string, session = FUTURE) => as(db, u, (tx) => tx.query('select public.makeup_schedule($1, $2)', [r.id, session]));
    for (const u of [U.teacherA1, U.studentA1, U.managerA2, U.accountantA]) await expectDenied(schedule(u), /not allowed/);
    await expectDenied(schedule(U.adminA1, id(11)), /session not available/); // прошедшее, проведённое
    await db.query(`insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period) values
      ('e4000000-0000-4000-8000-000000000202', $1, $2, $3, $4, $5, tstzrange(now() - interval '1 day', now() - interval '1 day' + interval '90 minutes'))`,
      [ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1b, ROOM.A1x]);
    await expectDenied(schedule(U.adminA1, 'e4000000-0000-4000-8000-000000000202'), /session not available/); // прошедшее, но не отмеченное
    await expectDenied(schedule(U.adminA1, id(14)), /session not available/); // другой филиал
    await expectDenied(schedule(U.adminA1, id(12)), /session not available/); // то самое пропущенное
    await as(db, U.adminA1, (tx) => tx.query('select public.makeup_schedule($1, $2)', [r.id, FUTURE]), { commit: true });
    expect((await req(U.studentA1))?.status).toBe('scheduled');
    expect(await notes(U.studentA1, 'makeup_scheduled')).toBe(1);
    expect(await notes(U.parentA1, 'makeup_scheduled')).toBe(1);
  });

  it('done or cancelled (with a reason); visible to the student, guardians, group teacher and branch staff only', async () => {
    const r = (await req(U.studentA1))!;
    await expectDenied(as(db, U.adminA1, (tx) => tx.query(`select public.makeup_resolve($1, 'cancelled')`, [r.id])), /reason required/);
    await as(db, U.adminA1, (tx) => tx.query(`select public.makeup_resolve($1, 'done')`, [r.id]), { commit: true });
    expect((await req(U.studentA1))?.status).toBe('done');
    await expectDenied(as(db, U.adminA1, (tx) => tx.query(`select public.makeup_resolve($1, 'done')`, [r.id])), /invalid transition/);
    const sees = (u: string) => as(db, u, (tx) => count(tx, 'select 1 from public.makeup_requests where id = $1', [r.id]));
    for (const u of [U.studentA1, U.parentA1, U.teacherA1, U.adminA1, U.managerA1, U.directorA]) expect(await sees(u), u).toBe(1);
    for (const u of [U.studentA1b, U.teacherA2, U.managerA2, U.directorB]) expect(await sees(u), u).toBe(0);
    await expectDenied(as(db, U.adminA1, (tx) => tx.query(`update public.makeup_requests set status = 'open' where id = $1`, [r.id])));
  });
});

describe('substitute teacher', () => {
  const NOW = 'e4000000-0000-4000-8000-000000000301'; // A1, идёт сейчас
  const LATER = 'e4000000-0000-4000-8000-000000000302'; // A1b, через 5 дней
  beforeAll(async () => {
    await db.query(`insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period) values
      ($1, $3, $4, $5, $6, $7, tstzrange(now() - interval '5 minutes', now() + interval '85 minutes')),
      ($2, $3, $4, $8, $9, $10, tstzrange(now() + interval '5 days', now() + interval '5 days 90 minutes'))`,
      [NOW, LATER, ORG.A, BRANCH.A1, GROUP.A1, U.teacherA1, ROOM.A1, GROUP.A1b, U.teacherA1b, ROOM.A1x]);
  });
  const substitute = (u: string, session: string, teacher: string, reason: string | null) =>
    as(db, u, (tx) => tx.query('select public.session_substitute($1, $2, $3)', [session, teacher, reason]));

  it('schedulers replace the teacher with a reason; only active teachers of the branch', async () => {
    await expectDenied(substitute(U.teacherA1, NOW, U.teacherA1b, 'болезнь'), /not allowed/);
    await expectDenied(substitute(U.managerA1, NOW, U.teacherA1b, null), /reason required/);
    await expectDenied(substitute(U.managerA1, NOW, U.teacherA2, 'болезнь'), /active teacher of this branch/);
    await expectDenied(substitute(U.managerA1, NOW, U.studentA1, 'болезнь'), /active teacher of this branch/);
    await expectDenied(substitute(U.managerA1, id(11), U.teacherA1b, 'болезнь'), /session not available/); // уже прошло
    await expectDenied(as(db, U.managerA1, (tx) => tx.query('update public.lesson_sessions set teacher_id = $1 where id = $2', [U.teacherA1b, NOW])), /not assigned to this group/);
    await substitute(U.managerA1, NOW, U.teacherA1b, 'Болезнь преподавателя').then(() => undefined);
    await as(db, U.managerA1, (tx) => tx.query('select public.session_substitute($1, $2, $3)', [NOW, U.teacherA1b, 'Болезнь преподавателя']), { commit: true });
    const s = (await rows<{ teacher_id: string; substitute_reason: string }>(db, 'select teacher_id, substitute_reason from public.lesson_sessions where id = $1', [NOW]))[0]!;
    expect(s).toEqual({ teacher_id: U.teacherA1b, substitute_reason: 'Болезнь преподавателя' });
    expect(await notes(U.teacherA1b, 'substitution_assigned')).toBe(1);
    expect(await count(db, `select 1 from public.lesson_session_changes where session_id = $1`, [NOW])).toBeGreaterThanOrEqual(1);
  });

  it('the substitute sees the roster and marks attendance only around that session', async () => {
    const sub = U.teacherA1b;
    expect(await as(db, sub, (tx) => count(tx, 'select 1 from public.lesson_sessions where id = $1', [NOW]))).toBe(1);
    expect(await as(db, sub, (tx) => count(tx, 'select 1 from public.enrollments where group_id = $1', [GROUP.A1]))).toBe(1);
    expect(await as(db, sub, (tx) => count(tx, 'select 1 from public.profiles where id = $1', [U.studentA1]))).toBe(1);
    await as(db, sub, (tx) => tx.query(`select public.mark_attendance($1, $2)`, [NOW, JSON.stringify([{ studentId: U.studentA1, status: 'present' }])]), { commit: true });
    expect(await as(db, sub, (tx) => count(tx, 'select 1 from public.attendance_records where session_id = $1', [NOW]))).toBe(1);
    // Замена далеко в будущем: само занятие видно, а список группы — ещё нет.
    await as(db, U.managerA1, (tx) => tx.query('select public.session_substitute($1, $2, $3)', [LATER, U.teacherA1, 'Отпуск']), { commit: true });
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.lesson_sessions where id = $1', [LATER]))).toBe(1);
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.enrollments where group_id = $1', [GROUP.A1b]))).toBe(0);
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.profiles where id = $1', [U.studentA1b]))).toBe(0);
  });

  it('returning the group teacher clears the substitution', async () => {
    await as(db, U.managerA1, (tx) => tx.query('select public.session_substitute($1, $2, null)', [LATER, U.teacherA1b]), { commit: true });
    const s = (await rows<{ teacher_id: string; substitute_reason: string | null }>(db, 'select teacher_id, substitute_reason from public.lesson_sessions where id = $1', [LATER]))[0]!;
    expect(s).toEqual({ teacher_id: U.teacherA1b, substitute_reason: null });
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.lesson_sessions where id = $1', [LATER]))).toBe(0);
  });
});
