import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asService, count, rows, type Tx } from '../db/harness';

/**
 * Этап 11: уведомления по событиям и по расписанию, без дублей; настройки пользователя;
 * очередь доставки во внешние каналы — статусы, ограниченные повторы, ошибки; Telegram.
 */
let db: PGlite;
const TEST = 'e1000000-0000-4000-8000-000000000001';
const S1 = 'e1000000-0000-4000-8000-000000000011'; // GROUP.A1, вчера
const S2 = 'e1000000-0000-4000-8000-000000000012'; // GROUP.A1, сегодня утром
const S_SOON = 'e1000000-0000-4000-8000-000000000013'; // GROUP.A1, через 3 часа

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.assessments (id, organization_id, course_id, title, max_attempts, reveal_answers, status) values
      ('${TEST}', '${ORG.A}', '${COURSE.A}', 'Unit test', 3, 'after_submit', 'published');
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period) values
      ('${S1}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() - interval '26 hours', now() - interval '25 hours')),
      ('${S2}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() - interval '3 hours', now() - interval '2 hours')),
      ('${S_SOON}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() + interval '3 hours', now() + interval '4 hours'));
  `);
}, 60_000);

const switchTo = (tx: Tx, sub: string | null, aal: 'aal1' | 'aal2' = 'aal2') =>
  sub === null
    ? tx.exec('set local role service_role')
    : tx.exec('set local role authenticated').then(() => tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal })]));
const kindsOf = async (tx: Tx, user: string, like = '%') =>
  (await rows<{ kind: string }>(tx, `select kind from public.notifications where recipient_id = $1 and kind like $2 order by created_at, kind`, [user, like])).map((r) => r.kind);
const absent = (tx: Tx, session: string, student = U.studentA1) =>
  tx.query(`insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source, marked_by) values ($1, $2, $3, $4, 'absent', 'teacher', $5)
            on conflict (session_id, student_id) do update set status = 'absent'`, [ORG.A, BRANCH.A1, session, student, U.teacherA1]);

describe('notifications on events, without duplicates', () => {
  it('homework: published → students; submitted → teachers; graded/returned → the student', async () => {
    const r = await asService(db, async (tx) => {
      const hw = (await rows<{ id: string }>(tx, `insert into public.assignments (organization_id, branch_id, group_id, title, max_score, status, created_by) values ($1, $2, $3, 'Essay 2', 10, 'published', $4) returning id`, [ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1b]))[0]!.id;
      await tx.query(`update public.assignments set status = 'closed' where id = $1`, [hw]);
      await tx.query(`update public.assignments set status = 'published' where id = $1`, [hw]); // повторная публикация — не дубль
      const sub = (await rows<{ id: string }>(tx, `insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body) values ($1, $2, $3, $4, 'My essay') returning id`, [ORG.A, BRANCH.A1, hw, U.studentA1b]))[0]!.id;
      await tx.query(`update public.assignment_submissions set body = 'My essay v2' where id = $1`, [sub]); // правка — не новое сообщение преподавателю
      await tx.query(`update public.assignment_submissions set status = 'returned', feedback = 'Add a conclusion' where id = $1`, [sub]);
      await tx.query(`update public.assignment_submissions set status = 'graded', score = 9, graded_at = now(), updated_at = now() + interval '1 second' where id = $1`, [sub]);
      return {
        student: (await rows<{ kind: string; status: string | null }>(tx, `select kind, payload ->> 'status' as status from public.notifications where recipient_id = $1 and payload ->> 'assignmentId' = $2 order by created_at, status nulls first`, [U.studentA1b, hw])),
        teacher: await count(tx, `select 1 from public.notifications where recipient_id = $1 and kind = 'submission_received' and payload ->> 'assignmentId' = $2`, [U.teacherA1b, hw]),
        other: await count(tx, `select 1 from public.notifications where recipient_id = $1 and payload ->> 'assignmentId' = $2`, [U.studentA1, hw]),
      };
    });
    expect(r.student).toEqual([
      { kind: 'homework_assigned', status: null },
      { kind: 'homework_graded', status: 'graded' },
      { kind: 'homework_graded', status: 'returned' },
    ]);
    expect(r.teacher).toBe(1);
    expect(r.other).toBe(0);
  });

  it('test result → the student and the guardian', async () => {
    const r = await asService(db, async (tx) => {
      await tx.query(`insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key) values ($1, $2, $3, 1, 7, 10, $4)`, [ORG.A, TEST, U.studentA1, randomUUID()]);
      return { student: await kindsOf(tx, U.studentA1, 'test_%'), parent: await kindsOf(tx, U.parentA1, 'test_%'), teacher: await kindsOf(tx, U.teacherA1, 'test_%') };
    });
    expect(r).toEqual({ student: ['test_result'], parent: ['test_result'], teacher: [] });
  });

  it('absence → student and guardian; a second absence in a row → branch leadership; re-marking does not duplicate', async () => {
    const r = await asService(db, async (tx) => {
      await absent(tx, S1);
      const managersAfterFirst = await count(tx, `select 1 from public.notifications where kind = 'manager_alert'`);
      await absent(tx, S2);
      await absent(tx, S2); // повторная отметка того же — без дублей
      return {
        managersAfterFirst,
        parent: await kindsOf(tx, U.parentA1, 'absence%'),
        student: await kindsOf(tx, U.studentA1, 'absence%'),
        managers: (await rows<{ recipient_id: string }>(tx, `select recipient_id from public.notifications where kind = 'manager_alert' order by recipient_id`)).map((x) => x.recipient_id),
      };
    });
    expect(r.managersAfterFirst).toBe(0);
    expect(r.parent).toEqual(['absence_alert', 'absence_alert']);
    expect(r.student).toEqual(['absence_alert', 'absence_alert']);
    expect(r.managers).toEqual([U.directorA, U.managerA1, U.adminA1].sort());
  });
});

describe('user preferences', () => {
  it('optional kinds can be turned off; important ones cannot be turned off in the app', async () => {
    const r = await as(db, U.studentA1, async (tx) => {
      await switchTo(tx, U.studentA1, 'aal1');
      await tx.query(`insert into public.notification_preferences (profile_id, kind, channel, enabled) values ($1, 'test_result', 'in_app', false)`, [U.studentA1]);
      let important = '';
      await tx.exec('savepoint s');
      try {
        await tx.query(`insert into public.notification_preferences (profile_id, kind, channel, enabled) values ($1, 'absence_alert', 'in_app', false)`, [U.studentA1]);
      } catch (e) {
        important = (e as Error).message;
        await tx.exec('rollback to savepoint s');
      }
      await tx.exec('savepoint f');
      const foreign = await tx.query(`insert into public.notification_preferences (profile_id, kind, channel, enabled) values ($1, 'test_result', 'in_app', false)`, [U.studentA1b]).then(
        () => 'allowed',
        async (e: Error) => {
          await tx.exec('rollback to savepoint f');
          return e.message;
        },
      );
      await switchTo(tx, null);
      await tx.query(`insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key) values ($1, $2, $3, 1, 5, 10, $4)`, [ORG.A, TEST, U.studentA1, randomUUID()]);
      return { important, foreign, student: await kindsOf(tx, U.studentA1, 'test_%'), parent: await kindsOf(tx, U.parentA1, 'test_%') };
    });
    expect(r.important).toMatch(/cannot be turned off/);
    expect(r.foreign).toMatch(/row-level security/);
    expect(r).toMatchObject({ student: [], parent: ['test_result'] });
  });

  it('external channels follow preferences: important → email by default, optional → only if asked', async () => {
    const r = await asService(db, async (tx) => {
      await absent(tx, S1); // важное
      await tx.query(`insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key) values ($1, $2, $3, 1, 5, 10, $4)`, [ORG.A, TEST, U.studentA1, randomUUID()]);
      await tx.query(`insert into public.notification_preferences (profile_id, kind, channel, enabled) values ($1, 'test_result', 'email', true), ($1, 'absence_alert', 'email', false)`, [U.parentA1]);
      await tx.query(`insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key) values ($1, $2, $3, 2, 6, 10, $4)`, [ORG.A, TEST, U.studentA1, randomUUID()]);
      await absent(tx, S2);
      return rows<{ kind: string; recipient: string; channel: string }>(tx, `
        select n.kind, case n.recipient_id when $1 then 'student' when $2 then 'parent' end as recipient, d.channel
          from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
         where n.recipient_id in ($1, $2) order by n.kind, recipient`, [U.studentA1, U.parentA1]);
    });
    // Пропуски: родитель — только первый (потом отключил email), ученик — оба; тест: только родитель (включил сам).
    expect(r).toEqual([
      { kind: 'absence_alert', recipient: 'parent', channel: 'email' },
      { kind: 'absence_alert', recipient: 'student', channel: 'email' },
      { kind: 'absence_alert', recipient: 'student', channel: 'email' },
      { kind: 'test_result', recipient: 'parent', channel: 'email' },
    ]);
  });
});

describe('delivery queue', () => {
  const claim = (tx: Tx) => tx.query<{ r: { id: string; channel: string; address: string | null; kind: string; locale: string }[] }>('select public.claim_deliveries(10) as r').then((x) => x.rows[0]!.r);
  const complete = (tx: Tx, id: string, outcome: string, error?: string) => tx.query('select public.complete_delivery($1, $2, null, $3)', [id, outcome, error ?? null]);

  it('a claimed delivery is not claimed twice; success is final; errors retry with a pause; attempts are limited', async () => {
    const r = await asService(db, async (tx) => {
      await absent(tx, S1);
      const first = await claim(tx);
      const second = await claim(tx); // уже «отправляется»
      const [a, b] = first;
      await complete(tx, a!.id, 'sent');
      await complete(tx, b!.id, 'error', 'SMTP 451 temporary');
      const afterRetry = await rows<{ status: string; attempts: number; future: boolean }>(tx, `select status, attempts, next_attempt_at > now() as future from public.notification_deliveries where id = $1`, [b!.id]);
      const notDue = await claim(tx); // пауза ещё не прошла
      // Исчерпать попытки: каждая неудача — после паузы.
      for (let i = 0; i < 4; i++) {
        await tx.query(`update public.notification_deliveries set next_attempt_at = now() - interval '1 second' where id = $1`, [b!.id]);
        const c = await claim(tx);
        await complete(tx, c[0]!.id, 'error', 'provider down');
      }
      const final = await rows<{ status: string; attempts: number; last_error: string }>(tx, `select status, attempts, last_error from public.notification_deliveries where id = $1`, [b!.id]);
      let twice = '';
      await tx.exec('savepoint t');
      try {
        await complete(tx, a!.id, 'error', 'late');
      } catch (e) {
        twice = (e as Error).message;
        await tx.exec('rollback to savepoint t');
      }
      return { first, second, afterRetry, notDue, final, twice, sent: (await rows<{ status: string }>(tx, 'select status from public.notification_deliveries where id = $1', [a!.id]))[0]!.status };
    });
    expect(r.first).toHaveLength(2);
    expect(r.first.every((d) => d.channel === 'email' && d.address?.endsWith('@example.test'))).toBe(true);
    expect(r.second).toEqual([]);
    expect(r.sent).toBe('sent');
    expect(r.afterRetry).toEqual([{ status: 'retry', attempts: 1, future: true }]);
    expect(r.notDue).toEqual([]);
    expect(r.final).toEqual([{ status: 'failed', attempts: 5, last_error: 'provider down' }]);
    expect(r.twice).toMatch(/not in progress/);
  });

  it('a delivery stuck in "sending" is reclaimed; permanent problems are recorded as skipped', async () => {
    const r = await asService(db, async (tx) => {
      await absent(tx, S1);
      const [a, b] = await claim(tx);
      await tx.query(`update public.notification_deliveries set locked_at = now() - interval '11 minutes' where id = $1`, [a!.id]);
      const reclaimed = (await claim(tx)).map((d) => d.id);
      await complete(tx, b!.id, 'skipped', 'channel not configured');
      return { reclaimed, a: a!.id, skipped: (await rows(tx, 'select status, last_error from public.notification_deliveries where id = $1', [b!.id]))[0] };
    });
    expect(r.reclaimed).toEqual([r.a]);
    expect(r.skipped).toEqual({ status: 'skipped', last_error: 'channel not configured' });
  });

  it('recipients see the status of their deliveries; the director sees the school; nobody else; users cannot drive the queue', async () => {
    const seen = await asService(db, async (tx) => {
      await absent(tx, S1);
      const out: Record<string, number> = {};
      for (const user of [U.parentA1, U.studentA1, U.directorA, U.teacherA1, U.studentA1b, U.directorB]) {
        await switchTo(tx, user);
        out[user] = await count(tx, 'select 1 from public.notification_deliveries');
      }
      return out;
    });
    expect(seen).toEqual({ [U.parentA1]: 1, [U.studentA1]: 1, [U.directorA]: 2, [U.teacherA1]: 0, [U.studentA1b]: 0, [U.directorB]: 0 });
    for (const sql of ['select public.claim_deliveries(10)', `select public.generate_scheduled_notifications(now())`, `select public.link_telegram('X', '1')`]) {
      await expectDenied(as(db, U.directorA, (tx) => tx.query(sql), { aal: 'aal2' }), /permission denied/);
    }
  });
});

describe('scheduled notifications', () => {
  const generate = (tx: Tx, at = 'now()') => tx.query<{ r: Record<string, number> }>(`select public.generate_scheduled_notifications(${at}) as r`).then((x) => x.rows[0]!.r);

  it('lesson reminders go to students and the teacher once', async () => {
    const r = await asService(db, async (tx) => {
      const first = await generate(tx);
      const second = await generate(tx);
      return { first: first.lessonReminders, second: second.created, student: await kindsOf(tx, U.studentA1, 'lesson%'), teacher: await kindsOf(tx, U.teacherA1, 'lesson%'), other: await kindsOf(tx, U.studentA1b, 'lesson%') };
    });
    expect(r).toEqual({ first: 2, second: 0, student: ['lesson_reminder'], teacher: ['lesson_reminder'], other: [] });
  });

  it('payment due in 3 days and overdue (weekly) go to the payer and the guardian', async () => {
    const r = await asService(db, async (tx) => {
      await tx.query(`insert into public.invoices (organization_id, branch_id, payer_id, number, total, status, due_on, created_by) values
        ($1, $2, $3, 'N-0001', 4500.00, 'issued', (now() at time zone 'Asia/Bishkek')::date + 3, $6),
        ($1, $4, $5, 'N-0002', 4500.00, 'issued', (now() at time zone 'Asia/Bishkek')::date - 10, $6)`, [ORG.A, BRANCH.A1, U.studentA1, BRANCH.A2, U.studentA2, U.accountantA]);
      const first = await generate(tx);
      const again = await generate(tx);
      return {
        first: [first.paymentDue, first.paymentOverdue],
        again: (again.created ?? 0) - (again.lessonReminders ?? 0),
        studentA1: await kindsOf(tx, U.studentA1, 'payment%'),
        parentA1: await kindsOf(tx, U.parentA1, 'payment%'),
        studentA2: await kindsOf(tx, U.studentA2, 'payment%'),
      };
    });
    expect(r).toEqual({ first: [2, 1], again: 0, studentA1: ['payment_due'], parentA1: ['payment_due'], studentA2: ['payment_overdue'] });
  });

  it('the weekly report goes to the director on Mondays only, once a week', async () => {
    const r = await asService(db, async (tx) => {
      const tuesday = await generate(tx, `'2026-11-03 09:00+06'::timestamptz`);
      const monday = await generate(tx, `'2026-11-02 09:00+06'::timestamptz`);
      const mondayAgain = await generate(tx, `'2026-11-02 18:00+06'::timestamptz`);
      const report = (await rows<{ payload: Record<string, unknown> }>(tx, `select payload from public.notifications where kind = 'weekly_report' and recipient_id = $1`, [U.directorA]))[0];
      return { tuesday: tuesday.weeklyReports, monday: monday.weeklyReports, mondayAgain: mondayAgain.weeklyReports, created: mondayAgain.created, report, others: await count(tx, `select 1 from public.notifications where kind = 'weekly_report' and recipient_id <> all($1)`, [[U.directorA, U.directorB]]) };
    });
    expect([r.tuesday, r.monday]).toEqual([0, 2]); // директора школ A и B
    expect(r.created).toBe(0);
    expect(r.report?.payload).toMatchObject({ week: '2026-W45'.replace('-W', '-'), received: expect.any(String) });
    expect(r.others).toBe(0);
  });
});

describe('Telegram linking', () => {
  it('a one-time code links the chat; wrong, reused or foreign codes do not', async () => {
    const r = await as(db, U.parentA1, async (tx) => {
      await switchTo(tx, U.parentA1, 'aal1');
      const code = (await tx.query<{ c: string }>('select public.create_telegram_link_code() as c')).rows[0]!.c;
      await switchTo(tx, null);
      const wrong = (await tx.query<{ ok: boolean }>(`select public.link_telegram('WRONG00000', '555') as ok`)).rows[0]!.ok;
      const ok = (await tx.query<{ ok: boolean }>(`select public.link_telegram($1, '777001') as ok`, [code.toLowerCase()])).rows[0]!.ok;
      const reused = (await tx.query<{ ok: boolean }>(`select public.link_telegram($1, '777002') as ok`, [code])).rows[0]!.ok;
      await absent(tx, S1);
      const channels = await rows(tx, `select d.channel from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.recipient_id = $1 order by d.channel`, [U.parentA1]);
      await switchTo(tx, U.studentA1, 'aal1');
      const foreignSees = await count(tx, 'select 1 from public.notification_channels');
      await switchTo(tx, U.parentA1, 'aal1');
      const ownSees = await rows(tx, 'select channel, address from public.notification_channels');
      return { code, wrong, ok, reused, channels, foreignSees, ownSees };
    });
    expect(r.code).toMatch(/^[0-9A-F]{10}$/);
    expect([r.wrong, r.ok, r.reused]).toEqual([false, true, false]);
    expect(r.channels).toEqual([{ channel: 'email' }, { channel: 'telegram' }]);
    expect(r.foreignSees).toBe(0);
    expect(r.ownSees).toEqual([{ channel: 'telegram', address: '777001' }]);
  });
});
