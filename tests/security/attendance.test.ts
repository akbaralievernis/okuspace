import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

/**
 * Этап 6: серии занятий в поясе филиала, конфликты, история изменений и уведомления,
 * посещаемость (окна отметки, исправления с причиной, коды занятия, устройства, камера).
 */
let db: PGlite;
const id = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// В фикстурах: занятие GROUP.A1 / teacherA1 / ROOM.A1 — 2026-11-02 10:00–11:30 (+06).
const S_FIXTURE_SQL = `(select id from public.lesson_sessions where group_id = '${GROUP.A1}' and lower(period) = '2026-11-02 04:00Z')`;
const S_NOW = id(1); // идёт сейчас: началось 30 минут назад
const S_PAST = id(2); // закончилось 72 часа назад — окно преподавателя закрыто
const S_SOON = id(3); // через 2 дня
const S_A2 = id(4); // филиал A2, идёт сейчас
const S_CANCELLED = id(5);

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period, status, cancel_reason) values
      ('${S_NOW}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() - interval '30 minutes', now() + interval '60 minutes'), 'scheduled', null),
      ('${S_PAST}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() - interval '74 hours', now() - interval '72 hours'), 'scheduled', null),
      ('${S_SOON}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() + interval '2 days', now() + interval '2 days 1 hour'), 'scheduled', null),
      ('${S_A2}', '${ORG.A}', '${BRANCH.A2}', '${GROUP.A2}', '${U.teacherA2}', '${ROOM.A2}', tstzrange(now() - interval '30 minutes', now() + interval '60 minutes'), 'scheduled', null),
      ('${S_CANCELLED}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() - interval '10 hours', now() - interval '9 hours'), 'cancelled', 'holiday');
  `);
}, 60_000);

/** Сменить пользователя внутри одной транзакции (как следующий запрос PostgREST). */
const switchTo = (tx: Tx, sub: string, aal: 'aal1' | 'aal2' = 'aal1') =>
  tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal })]);

const mark = (tx: Tx, session: string, marks: object[], reason?: string) =>
  tx.query<{ n: number }>('select public.mark_attendance($1, $2, $3) as n', [session, JSON.stringify(marks), reason ?? null]);
const openCode = async (tx: Tx, session: string) =>
  (await tx.query<{ r: { code: string; expiresAt: string } }>('select public.open_attendance_code($1) as r', [session])).rows[0]!.r.code;
const checkIn = (tx: Tx, code: string) => tx.query<{ id: string }>('select public.check_in_with_code($1) as id', [code]);
const series = (tx: Tx, args: { group: string; teacher: string; room: string | null; first: string; weekdays: number[]; start: string; minutes: number; count: number }) =>
  tx.query<{ id: string }>('select public.create_session_series($1, $2, $3, $4, $5, $6, $7, $8, $9) as id', [
    args.group, args.teacher, args.room, args.room ? null : 'https://meet.example.test/x', args.first, args.weekdays, args.start, args.minutes, args.count,
  ]);

describe('session series in the branch time zone', () => {
  it('creates sessions on the chosen weekdays at local time (Bishkek, UTC+6)', async () => {
    const starts = await as(db, U.adminA1, async (tx) => {
      const ids = (await series(tx, { group: GROUP.A1b, teacher: U.teacherA1b, room: ROOM.A1x, first: '2027-01-04', weekdays: [1, 3], start: '18:00', minutes: 90, count: 4 })).rows.map((r) => r.id);
      return rows<{ s: string; e: string }>(tx, `select to_char(lower(period) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as s, to_char(upper(period) at time zone 'UTC', 'HH24:MI') as e from public.lesson_sessions where id = any($1) order by lower(period)`, [ids]);
    });
    expect(starts).toEqual([
      { s: '2027-01-04 12:00', e: '13:30' },
      { s: '2027-01-06 12:00', e: '13:30' },
      { s: '2027-01-11 12:00', e: '13:30' },
      { s: '2027-01-13 12:00', e: '13:30' },
    ]);
  });

  it('handles daylight saving time: 18:00 stays 18:00 local across the switch (Europe/Berlin)', async () => {
    const starts = await db.transaction(async (tx) => {
      await tx.query(`update public.branches set timezone = 'Europe/Berlin' where id = $1`, [BRANCH.A1]);
      await switchTo(tx, U.adminA1);
      await tx.exec('set local role authenticated');
      const ids = (await series(tx, { group: GROUP.A1b, teacher: U.teacherA1b, room: ROOM.A1x, first: '2027-03-22', weekdays: [1], start: '18:00', minutes: 60, count: 2 })).rows.map((r) => r.id);
      const out = await rows<{ s: string }>(tx, `select to_char(lower(period) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as s from public.lesson_sessions where id = any($1) order by lower(period)`, [ids]);
      await tx.rollback();
      return out;
    });
    // 22 марта — зимнее время (UTC+1), 29 марта — летнее (UTC+2).
    expect(starts.map((r) => r.s)).toEqual(['2027-03-22 17:00', '2027-03-29 16:00']);
  });

  it('a conflict rolls back the whole series and names the date', async () => {
    const result = await as(db, U.adminA1, async (tx) => {
      const before = await count(tx, 'select 1 from public.lesson_sessions where group_id = $1', [GROUP.A1]);
      await tx.exec('savepoint s');
      let error = '';
      try {
        // 26 октября и 2 ноября по понедельникам; 2 ноября 10:00 аудитория 101 и teacherA1 уже заняты.
        await series(tx, { group: GROUP.A1, teacher: U.teacherA1, room: ROOM.A1, first: '2026-10-26', weekdays: [1], start: '10:30', minutes: 60, count: 2 });
      } catch (e) {
        error = (e as Error).message;
        await tx.exec('rollback to savepoint s');
      }
      const after = await count(tx, 'select 1 from public.lesson_sessions where group_id = $1', [GROUP.A1]);
      return { before, after, error };
    });
    expect(result.error).toMatch(/schedule conflict on 2026-11-02/);
    expect(result.after).toBe(result.before);
  });

  it('only schedulers create series; parameters are bounded', async () => {
    for (const actor of [U.teacherA1, U.studentA1, U.directorB]) {
      await expectDenied(
        as(db, actor, (tx) => series(tx, { group: GROUP.A1, teacher: U.teacherA1, room: ROOM.A1x, first: '2027-02-01', weekdays: [2], start: '09:00', minutes: 60, count: 1 })),
        /row-level security|permission denied|not available/,
      );
    }
    await expectDenied(
      as(db, U.adminA1, (tx) => series(tx, { group: GROUP.A1b, teacher: U.teacherA1b, room: ROOM.A1x, first: '2027-02-01', weekdays: [8], start: '09:00', minutes: 60, count: 1 })),
      /invalid series parameters/,
    );
    await expectDenied(
      as(db, U.adminA1, (tx) => series(tx, { group: GROUP.A1b, teacher: U.teacherA1b, room: ROOM.A1x, first: '2027-02-01', weekdays: [2], start: '09:00', minutes: 60, count: 500 })),
      /invalid series parameters/,
    );
  });
});

describe('conflict detection', () => {
  const conflicts = (tx: Tx, branch: string, teacher: string, room: string | null, start: string, end: string) =>
    tx.query<{ r: { kind: string; sessionId: string | null; groupName: string | null }[] }>('select public.session_conflicts($1, $2, $3, $4, $5) as r', [
      branch, teacher, room, start, end,
    ]);

  it('reports teacher and classroom conflicts with the existing session', async () => {
    const r = await as(db, U.adminA1, (tx) => conflicts(tx, BRANCH.A1, U.teacherA1b, ROOM.A1, '2026-11-02 05:00Z', '2026-11-02 06:00Z'));
    expect(r.rows[0]!.r).toEqual([expect.objectContaining({ kind: 'classroom', groupName: 'EN-A1-1' })]);
    const t = await as(db, U.adminA1, (tx) => conflicts(tx, BRANCH.A1, U.teacherA1, ROOM.A1x, '2026-11-02 05:00Z', '2026-11-02 06:00Z'));
    expect(t.rows[0]!.r.map((c) => c.kind)).toEqual(['teacher']);
    const none = await as(db, U.adminA1, (tx) => conflicts(tx, BRANCH.A1, U.teacherA1b, ROOM.A1x, '2026-11-02 05:30Z', '2026-11-02 06:00Z'));
    expect(none.rows[0]!.r).toEqual([]);
  });

  it('does not reveal details of groups the caller cannot see', async () => {
    // adminA1 проверяет время для teacherA2: занятие филиала A2 видно только как «конфликт преподавателя».
    const r = await as(db, U.adminA1, (tx) =>
      tx.query<{ r: { kind: string; sessionId: string | null; groupName: string | null }[] }>(
        `select public.session_conflicts($1, $2, null, now(), now() + interval '10 minutes') as r`,
        [BRANCH.A1, U.teacherA2],
      ),
    );
    expect(r.rows[0]!.r).toEqual([expect.objectContaining({ kind: 'teacher', sessionId: null, groupName: null })]);
  });

  it('is available to schedulers of the branch only', async () => {
    for (const actor of [U.teacherA1, U.studentA1, U.adminA1]) {
      const branch = actor === U.adminA1 ? BRANCH.A2 : BRANCH.A1;
      await expectDenied(as(db, actor, (tx) => conflicts(tx, branch, U.teacherA1, null, '2026-11-02 05:00Z', '2026-11-02 06:00Z')), /not allowed/);
    }
  });
});

describe('schedule changes are logged and notify the right people', () => {
  it('rescheduling writes history and notifies students, guardians and teachers — not the author', async () => {
    const r = await as(db, U.adminA1, async (tx) => {
      const session = (await rows<{ id: string }>(tx, `select id from public.lesson_sessions where id = ${S_FIXTURE_SQL}`))[0]!.id;
      await tx.query(`update public.lesson_sessions set period = '[2026-11-03 10:00+06, 2026-11-03 11:30+06)', change_note = 'teacher at a seminar' where id = $1`, [session]);
      const changes = await rows<{ kinds: string[]; note: string }>(tx, 'select kinds, note from public.lesson_session_changes where session_id = $1', [session]);
      const seen: Record<string, { kind: string; note: string; oldStart: string }[]> = {};
      for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.adminA1, U.studentA1b, U.teacherA1b]) {
        await switchTo(tx, user);
        seen[user] = await rows(tx, `select kind, payload ->> 'note' as note, payload ->> 'oldStart' as "oldStart" from public.notifications`);
      }
      return { changes, seen };
    });
    expect(r.changes).toEqual([{ kinds: ['rescheduled'], note: 'teacher at a seminar' }]);
    for (const user of [U.studentA1, U.parentA1, U.teacherA1]) {
      expect(r.seen[user], user).toEqual([expect.objectContaining({ kind: 'session_rescheduled', note: 'teacher at a seminar' })]);
    }
    for (const user of [U.adminA1, U.studentA1b, U.teacherA1b]) expect(r.seen[user], user).toEqual([]);
  });

  it('the author is not notified about their own change, even when they also teach the group', async () => {
    const r = await asMfa(db, U.managerA1, async (tx) => {
      // Менеджер филиала делает adminA1 ещё и преподавателем группы A1 (себе роль выдать нельзя).
      await tx.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, 'teacher')`, [ORG.A, BRANCH.A1, U.adminA1]);
      await tx.query(`insert into public.group_teachers (organization_id, branch_id, group_id, teacher_id, role) values ($1, $2, $3, $4, 'assistant')`, [
        ORG.A, BRANCH.A1, GROUP.A1, U.adminA1,
      ]);
      await switchTo(tx, U.adminA1, 'aal2');
      await tx.query(`update public.lesson_sessions set online_url = 'https://meet.example.test/moved' where id = $1`, [S_SOON]);
      const author = await count(tx, 'select 1 from public.notifications');
      await switchTo(tx, U.teacherA1);
      return { author, teacher: await count(tx, 'select 1 from public.notifications') };
    });
    expect(r).toEqual({ author: 0, teacher: 1 });
  });

  it('a cancellation notifies with its reason; a cancelled session cannot be changed again', async () => {
    const kinds = await as(db, U.adminA1, async (tx) => {
      await tx.query(`update public.lesson_sessions set status = 'cancelled', cancel_reason = 'public holiday' where id = $1`, [S_SOON]);
      await switchTo(tx, U.studentA1);
      return rows<{ kind: string; note: string }>(tx, `select kind, payload ->> 'note' as note from public.notifications`);
    });
    expect(kinds).toEqual([{ kind: 'session_cancelled', note: 'public holiday' }]);
    await expectDenied(
      as(db, U.adminA1, (tx) => tx.query(`update public.lesson_sessions set period = tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour') where id = $1`, [S_CANCELLED])),
      /cancelled session cannot be changed/,
    );
  });

  it('changes to long-past sessions are logged but notify nobody', async () => {
    const r = await as(db, U.adminA1, async (tx) => {
      await tx.query(`update public.lesson_sessions set classroom_id = $2 where id = $1`, [S_PAST, ROOM.A1]);
      return {
        changes: await count(tx, 'select 1 from public.lesson_session_changes where session_id = $1', [S_PAST]),
        notes: await count(tx, `select 1 from public.notifications where payload ->> 'sessionId' = $1`, [S_PAST]),
      };
    });
    expect(r).toEqual({ changes: 1, notes: 0 });
  });

  it('completed sessions cannot be moved; history is append-only', async () => {
    await expectDenied(
      as(db, U.adminA1, async (tx) => {
        await tx.query(`update public.lesson_sessions set status = 'done' where id = $1`, [S_PAST]);
        await tx.query(`update public.lesson_sessions set period = tstzrange(now(), now() + interval '1 hour') where id = $1`, [S_PAST]);
      }),
      /completed session cannot be rescheduled/,
    );
    await expectDenied(
      asService(db, async (tx) => {
        await tx.query(`update public.lesson_sessions set change_note = 'x', online_url = 'https://meet.example.test/new' where id = $1`, [S_SOON]);
        await tx.query(`delete from public.lesson_session_changes where session_id = $1`, [S_SOON]);
      }),
      /append-only/,
    );
  });

  it('recipients can only mark their own notifications as read', async () => {
    const r = await as(db, U.adminA1, async (tx) => {
      await tx.query(`update public.lesson_sessions set online_url = 'https://meet.example.test/new' where id = $1`, [S_SOON]);
      await switchTo(tx, U.parentA1);
      const own = (await tx.query(`update public.notifications set read_at = now()`)).affectedRows;
      await switchTo(tx, U.studentA1b);
      const foreign = (await tx.query(`update public.notifications set read_at = now()`)).affectedRows;
      return { own, foreign };
    });
    expect(r).toEqual({ own: 1, foreign: 0 });
    await expectDenied(
      as(db, U.adminA1, async (tx) => {
        await tx.query(`update public.lesson_sessions set online_url = 'https://meet.example.test/new' where id = $1`, [S_SOON]);
        await switchTo(tx, U.studentA1);
        await tx.query(`update public.notifications set payload = '{}'`);
      }),
      /permission denied/,
    );
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key) values ($1, $2, 'session_changed', '{}', 'x')`, [ORG.A, U.studentA1])));
  });
});

describe('attendance marks', () => {
  const present = [{ studentId: U.studentA1, status: 'present' }];

  it('the teacher marks during the lesson; re-sending the same marks creates no duplicates', async () => {
    const r = await as(db, U.teacherA1, async (tx) => {
      const first = (await mark(tx, S_NOW, present)).rows[0]!.n;
      const again = (await mark(tx, S_NOW, present)).rows[0]!.n;
      return {
        first,
        again,
        records: await count(tx, 'select 1 from public.attendance_records where session_id = $1', [S_NOW]),
        history: await count(tx, 'select 1 from public.attendance_record_history where session_id = $1', [S_NOW]),
        session: (await rows<{ status: string }>(tx, 'select status from public.lesson_sessions where id = $1', [S_NOW]))[0]!.status,
      };
    });
    expect(r).toEqual({ first: 1, again: 0, records: 1, history: 1, session: 'done' });
  });

  it('every change is kept in the history with the author', async () => {
    const history = await as(db, U.teacherA1, async (tx) => {
      await mark(tx, S_NOW, present);
      await mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'late', minutesLate: 12 }]);
      await mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'absent', absenceReason: 'illness', note: 'called in' }]);
      return rows(tx, 'select status, minutes_late, absence_reason, changed_by from public.attendance_record_history where session_id = $1 order by id', [S_NOW]);
    });
    expect(history).toEqual([
      { status: 'present', minutes_late: null, absence_reason: null, changed_by: U.teacherA1 },
      { status: 'late', minutes_late: 12, absence_reason: null, changed_by: U.teacherA1 },
      { status: 'absent', minutes_late: null, absence_reason: 'illness', changed_by: U.teacherA1 },
    ]);
  });

  it('inconsistent marks are rejected: lateness only for "late", reasons only for absences', async () => {
    await expectDenied(as(db, U.teacherA1, (tx) => mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'sleeping' }])), /check constraint/);
    // minutesLate для «present» и причина для «present» отбрасываются функцией, а не сохраняются.
    const row = await as(db, U.teacherA1, async (tx) => {
      await mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'present', minutesLate: 5, absenceReason: 'illness' }]);
      return (await rows(tx, 'select minutes_late, absence_reason from public.attendance_records where session_id = $1', [S_NOW]))[0];
    });
    expect(row).toEqual({ minutes_late: null, absence_reason: null });
  });

  it('only students enrolled in the group can be marked', async () => {
    await expectDenied(as(db, U.teacherA1, (tx) => mark(tx, S_NOW, [{ studentId: U.studentA1b, status: 'present' }])), /not enrolled/);
    await expectDenied(as(db, U.teacherA1, (tx) => mark(tx, S_NOW, [{ studentId: U.studentB, status: 'present' }])), /not enrolled/);
  });

  it('other teachers, students, guardians and other schools cannot mark', async () => {
    for (const actor of [U.teacherA1b, U.teacherA2, U.studentA1, U.parentA1, U.directorB, U.managerA1]) {
      await expectDenied(as(db, actor, (tx) => mark(tx, S_NOW, present)), /not available/);
    }
  });

  it('teachers mark within the window only; cancelled sessions cannot be marked', async () => {
    await expectDenied(as(db, U.teacherA1, (tx) => mark(tx, S_PAST, present)), /not available/);
    await expectDenied(as(db, U.teacherA1, (tx) => mark(tx, S_SOON, present)), /not available/);
    await expectDenied(as(db, U.teacherA1, (tx) => mark(tx, S_CANCELLED, present)), /not available/);
    await expectDenied(asMfa(db, U.adminA1, (tx) => mark(tx, S_CANCELLED, present)), /not available/);
  });

  it('staff corrections need attendance.manage, MFA and a reason for existing marks', async () => {
    // Без MFA — нельзя.
    await expectDenied(as(db, U.adminA1, (tx) => mark(tx, S_PAST, present)), /not available/);
    const r = await asMfa(db, U.adminA1, async (tx) => {
      await mark(tx, S_PAST, present); // первая отметка после окна преподавателя — причина не обязательна
      await tx.exec('savepoint s');
      let error = '';
      try {
        await mark(tx, S_PAST, [{ studentId: U.studentA1, status: 'excused', absenceReason: 'family' }]);
      } catch (e) {
        error = (e as Error).message;
        await tx.exec('rollback to savepoint s');
      }
      await mark(tx, S_PAST, [{ studentId: U.studentA1, status: 'excused', absenceReason: 'family' }], 'medical certificate received');
      return {
        error,
        history: await rows(tx, 'select status, source, reason from public.attendance_record_history where session_id = $1 order by id', [S_PAST]),
      };
    });
    expect(r.error).toMatch(/requires a reason/);
    expect(r.history).toEqual([
      { status: 'present', source: 'admin', reason: null },
      { status: 'excused', source: 'admin', reason: 'medical certificate received' },
    ]);
    // Менеджер другого филиала не исправляет.
    await expectDenied(asMfa(db, U.managerA2, (tx) => mark(tx, S_PAST, present, 'x')), /not available/);
  });

  it('records cannot be written, edited or deleted directly; history is append-only', async () => {
    await expectDenied(
      as(db, U.teacherA1, (tx) =>
        tx.query(`insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source) values ($1, $2, $3, $4, 'present', 'teacher')`, [
          ORG.A, BRANCH.A1, S_NOW, U.studentA1,
        ]),
      ),
    );
    await expectDenied(
      as(db, U.teacherA1, async (tx) => {
        await mark(tx, S_NOW, present);
        await tx.query(`update public.attendance_records set status = 'absent' where session_id = $1`, [S_NOW]);
      }),
    );
    await expectDenied(
      asService(db, async (tx) => {
        await tx.query(`insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source) values ($1, $2, $3, $4, 'present', 'teacher')`, [
          ORG.A, BRANCH.A1, S_NOW, U.studentA1,
        ]);
        await tx.query(`delete from public.attendance_records where session_id = $1`, [S_NOW]);
      }),
      /append-only/,
    );
    await expectDenied(
      asService(db, async (tx) => {
        await tx.query(`insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source) values ($1, $2, $3, $4, 'present', 'teacher')`, [
          ORG.A, BRANCH.A1, S_NOW, U.studentA1,
        ]);
        await tx.query(`update public.attendance_record_history set status = 'absent'`);
      }),
      /append-only/,
    );
  });

  it('visibility: the student, the guardian, the group teacher and branch staff — nobody else', async () => {
    const seen = await as(db, U.teacherA1, async (tx) => {
      await mark(tx, S_NOW, present);
      const out: Record<string, number> = {};
      for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.managerA1, U.directorA, U.studentA1b, U.teacherA1b, U.managerA2, U.directorB]) {
        await switchTo(tx, user);
        out[user] = await count(tx, 'select 1 from public.attendance_records') + (await count(tx, 'select 1 from public.attendance_record_history'));
      }
      return out;
    });
    for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.managerA1, U.directorA]) expect(seen[user], user).toBe(2);
    for (const user of [U.studentA1b, U.teacherA1b, U.managerA2, U.directorB]) expect(seen[user], user).toBe(0);
  });
});

describe('session code check-in', () => {
  it('the student checks in once: one event, one "present" mark from the code', async () => {
    const r = await as(db, U.teacherA1, async (tx) => {
      const code = await openCode(tx, S_NOW);
      await switchTo(tx, U.studentA1);
      const first = (await checkIn(tx, code)).rows[0]!.id;
      const second = (await checkIn(tx, code)).rows[0]!.id;
      return {
        code,
        first,
        second,
        events: await count(tx, 'select 1 from public.attendance_events where session_id = $1', [S_NOW]),
        records: await rows(tx, 'select status, source, minutes_late from public.attendance_records where session_id = $1', [S_NOW]),
      };
    });
    expect(r.code).toMatch(/^\d{6}$/);
    expect([r.first, r.second]).toEqual([S_NOW, S_NOW]);
    expect(r.events).toBe(1);
    // Занятие началось 30 минут назад (> 10 минут) — отметка «опоздал».
    expect(r.records).toEqual([{ status: 'late', source: 'code', minutes_late: expect.any(Number) }]);
    expect((r.records[0] as { minutes_late: number }).minutes_late).toBeGreaterThanOrEqual(30);
  });

  it('a code does not work for students of another group or with a wrong value', async () => {
    const results = await as(db, U.teacherA1, async (tx) => {
      const code = await openCode(tx, S_NOW);
      const out: (string | null)[] = [];
      for (const [user, value] of [
        [U.studentA1b, code],
        [U.studentA2, code],
        [U.studentA1, code === '000000' ? '000001' : '000000'],
        [U.studentA1, 'abc'],
      ] as const) {
        await switchTo(tx, user);
        out.push((await checkIn(tx, value)).rows[0]!.id);
      }
      return { out, records: await count(tx, 'select 1 from public.attendance_events') };
    });
    expect(results.out).toEqual([null, null, null, null]);
    expect(results.records).toBe(0);
  });

  it('guessing is rate-limited: failed attempts are counted, the 11th within 10 minutes is refused', async () => {
    const r = await as(db, U.studentA1, async (tx) => {
      const answers: (string | null)[] = [];
      for (let i = 0; i < 10; i++) answers.push((await checkIn(tx, String(100000 + i))).rows[0]!.id);
      let error = '';
      try {
        await checkIn(tx, '123456');
      } catch (e) {
        error = (e as Error).message;
      }
      return { answers, error };
    });
    expect(r.answers.every((a) => a === null)).toBe(true);
    expect(r.error).toMatch(/too many attempts/);
    // Сам счётчик пользователю недоступен.
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`select public.hit_rate_limit('attendance-code:x', 1000, 600)`)), /permission denied/);
  });

  it('only the session teacher (or staff with MFA) opens a code; codes are never readable', async () => {
    for (const actor of [U.teacherA1b, U.studentA1, U.parentA1]) {
      await expectDenied(as(db, actor, (tx) => openCode(tx, S_NOW)), /not available/);
    }
    await expect(asMfa(db, U.adminA1, (tx) => openCode(tx, S_NOW))).resolves.toMatch(/^\d{6}$/);
    await expectDenied(as(db, U.teacherA1, (tx) => openCode(tx, S_PAST)), /not available/);
    await expectDenied(
      as(db, U.teacherA1, async (tx) => {
        await openCode(tx, S_NOW);
        await tx.query('select * from public.attendance_codes');
      }),
    );
  });

  it('the teacher can override a code mark; the change is in the history', async () => {
    const history = await as(db, U.teacherA1, async (tx) => {
      const code = await openCode(tx, S_NOW);
      await switchTo(tx, U.studentA1);
      await checkIn(tx, code);
      await switchTo(tx, U.teacherA1);
      await mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'left_early', note: 'left after 40 minutes' }]);
      return rows(tx, 'select status, source from public.attendance_record_history where session_id = $1 order by id', [S_NOW]);
    });
    expect(history).toEqual([
      { status: 'late', source: 'code' },
      { status: 'left_early', source: 'teacher' },
    ]);
  });
});

describe('device events: card and camera', () => {
  const ingest = (tx: Tx, session: string, student: string | null, source: string, key: string, at = 'now()') =>
    tx.query<{ id: string }>(`select public.ingest_attendance_event($1, $2, $3, 'check_in', ${at}, $4, 'reader-1', null) as id`, [session, student, source, key]);

  it('only the integration server (service role) can submit device events', async () => {
    for (const actor of [U.teacherA1, U.adminA1, U.studentA1]) {
      await expectDenied(as(db, actor, (tx) => ingest(tx, S_NOW, U.studentA1, 'card', 'k1')), /permission denied/);
    }
  });

  it('a card tap marks attendance once, even when the device re-sends the event', async () => {
    const r = await asService(db, async (tx) => {
      const a = (await ingest(tx, S_NOW, U.studentA1, 'card', 'tap-1', `now() - interval '28 minutes'`)).rows[0]!.id;
      const b = (await ingest(tx, S_NOW, U.studentA1, 'card', 'tap-1', `now() - interval '28 minutes'`)).rows[0]!.id;
      return {
        same: a === b,
        events: await count(tx, 'select 1 from public.attendance_events where session_id = $1', [S_NOW]),
        records: await rows(tx, 'select status, source, evidence_event_id is not null as evidence from public.attendance_records where session_id = $1', [S_NOW]),
      };
    });
    expect(r).toEqual({ same: true, events: 1, records: [{ status: 'present', source: 'card', evidence: true }] });
  });

  it('a camera event alone is never a confirmed mark', async () => {
    const r = await asService(db, async (tx) => {
      await ingest(tx, S_NOW, U.studentA1, 'camera', 'cam-1');
      await ingest(tx, S_NOW, null, 'camera', 'cam-2'); // человек без идентификации — только подсчёт
      return {
        events: await count(tx, 'select 1 from public.attendance_events where session_id = $1', [S_NOW]),
        records: await count(tx, 'select 1 from public.attendance_records where session_id = $1', [S_NOW]),
      };
    });
    expect(r).toEqual({ events: 2, records: 0 });
  });

  it('a person confirms a camera event; the mark keeps the evidence and the confirmer', async () => {
    const r = await asService(db, async (tx) => {
      const event = (await ingest(tx, S_NOW, U.studentA1, 'camera', 'cam-3')).rows[0]!.id;
      const anonymous = (await ingest(tx, S_NOW, null, 'camera', 'cam-4')).rows[0]!.id;
      await tx.exec('set local role authenticated');
      await switchTo(tx, U.teacherA1b);
      await tx.exec('savepoint s');
      let denied = '';
      try {
        await tx.query('select public.confirm_camera_event($1)', [event]);
      } catch (e) {
        denied = (e as Error).message;
        await tx.exec('rollback to savepoint s');
      }
      await switchTo(tx, U.teacherA1);
      await tx.exec('savepoint t');
      let anonymousError = '';
      try {
        await tx.query('select public.confirm_camera_event($1)', [anonymous]);
      } catch (e) {
        anonymousError = (e as Error).message;
        await tx.exec('rollback to savepoint t');
      }
      await tx.query('select public.confirm_camera_event($1)', [event]);
      return {
        denied,
        anonymousError,
        record: (await rows(tx, 'select status, source, marked_by, evidence_event_id from public.attendance_records where session_id = $1', [S_NOW]))[0],
        event,
      };
    });
    expect(r.denied).toMatch(/not available/);
    expect(r.anonymousError).toMatch(/cannot be confirmed/);
    expect(r.record).toEqual({ status: 'present', source: 'camera', marked_by: U.teacherA1, evidence_event_id: r.event });
  });

  it('camera marks without a confirming person are rejected by the database', async () => {
    await expectDenied(
      asService(db, async (tx) => {
        const event = (await ingest(tx, S_NOW, U.studentA1, 'camera', 'cam-5')).rows[0]!.id;
        await tx.query(
          `insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source, evidence_event_id) values ($1, $2, $3, $4, 'present', 'camera', $5)`,
          [ORG.A, BRANCH.A1, S_NOW, U.studentA1, event],
        );
      }),
      /attendance_records_camera_check/,
    );
  });
});

describe('one lesson, one attendance record per student', () => {
  it('code, card, camera and teacher marks for the same student end in exactly one record', async () => {
    const r = await asService(db, async (tx) => {
      await tx.query(`select public.ingest_attendance_event($1, $2, 'card', 'check_in', now() - interval '29 minutes', 'tap-x', null, null)`, [S_NOW, U.studentA1]);
      await tx.query(`select public.ingest_attendance_event($1, $2, 'camera', 'check_in', now(), 'cam-x', null, 0.91)`, [S_NOW, U.studentA1]);
      await tx.exec('set local role authenticated');
      await switchTo(tx, U.teacherA1);
      const code = await openCode(tx, S_NOW);
      await switchTo(tx, U.studentA1);
      await checkIn(tx, code);
      await switchTo(tx, U.teacherA1);
      await mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'present' }]);
      return {
        records: await count(tx, 'select 1 from public.attendance_records where session_id = $1 and student_id = $2', [S_NOW, U.studentA1]),
        events: await count(tx, 'select 1 from public.attendance_events where session_id = $1', [S_NOW]),
      };
    });
    expect(r).toEqual({ records: 1, events: 3 });
  });
});

describe('schedule_window (calendar data)', () => {
  type Item = { id: string; groupName: string; timezone: string; teacherName: string | null; marks: { studentId: string; status: string }[] };
  const window = (tx: Tx) =>
    tx.query<{ r: Item[] }>(`select public.schedule_window(now() - interval '1 day', now() + interval '3 days') as r`).then((x) => x.rows[0]!.r);

  it('returns only sessions the viewer may see, with names and the branch time zone', async () => {
    const byUser: Record<string, string[]> = {};
    for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.studentA1b, U.teacherA2, U.managerA1, U.directorB]) {
      byUser[user] = (await as(db, user, window)).map((s) => s.id).sort();
    }
    const a1 = [S_NOW, S_SOON, S_CANCELLED].sort(); // отменённые тоже показываются; S_PAST — раньше окна
    expect(byUser[U.studentA1]).toEqual(a1);
    expect(byUser[U.parentA1]).toEqual(a1);
    expect(byUser[U.teacherA1]).toEqual(a1);
    expect(byUser[U.managerA1]).toEqual(a1);
    expect(byUser[U.teacherA2]).toEqual([S_A2]);
    expect(byUser[U.studentA1b]).toEqual([]);
    expect(byUser[U.directorB]).toEqual([]);
    const item = (await as(db, U.studentA1, window)).find((s) => s.id === S_NOW)!;
    expect(item).toMatchObject({ groupName: 'EN-A1-1', timezone: 'Asia/Bishkek', teacherName: 'teacherA1' });
  });

  it('includes attendance marks only of the viewer or their child', async () => {
    const r = await as(db, U.teacherA1, async (tx) => {
      await mark(tx, S_NOW, [{ studentId: U.studentA1, status: 'late', minutesLate: 5 }]);
      const out: Record<string, unknown[]> = {};
      for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.managerA1]) {
        await switchTo(tx, user);
        out[user] = (await window(tx)).find((s) => s.id === S_NOW)!.marks;
      }
      return out;
    });
    expect(r[U.studentA1]).toEqual([expect.objectContaining({ studentId: U.studentA1, status: 'late' })]);
    expect(r[U.parentA1]).toEqual([expect.objectContaining({ studentId: U.studentA1, status: 'late' })]);
    expect(r[U.teacherA1]).toEqual([]);
    expect(r[U.managerA1]).toEqual([]);
  });

  it('rejects inverted or too long periods', async () => {
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`select public.schedule_window(now(), now() - interval '1 day')`)), /invalid period/);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`select public.schedule_window(now(), now() + interval '90 days')`)), /invalid period/);
    await expectDenied(as(db, null, (tx) => tx.query(`select public.schedule_window(now(), now() + interval '1 day')`)), /permission denied/);
  });
});
