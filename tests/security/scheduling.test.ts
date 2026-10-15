import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, count } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

// В фикстурах: GROUP.A1 / teacherA1 / ROOM.A1 — 2026-11-02 10:00–11:30 (+06, Бишкек).
const session = (group: string, teacher: string, room: string | null, period: string, extra = '') =>
  as(db, U.adminA1, (tx) =>
    tx.query(
      `insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period, online_url${extra ? ', status, cancel_reason' : ''})
       values ($1, $2, $3, $4, $5, $6::tstzrange, ${room ? 'null' : `'https://meet.example.test/x'`}${extra})`,
      [ORG.A, BRANCH.A1, group, teacher, room, period],
    ),
  );

describe('double booking protection', () => {
  it('the same teacher cannot have overlapping sessions', async () => {
    // teacherA1 назначен и в A1b для проверки — назначаем внутри той же транзакции.
    await expectDenied(
      as(db, U.adminA1, async (tx) => {
        await tx.query(
          `insert into public.group_teachers (organization_id, branch_id, group_id, teacher_id, role) values ($1, $2, $3, $4, 'assistant')`,
          [ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1],
        );
        await tx.query(
          `insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period)
           values ($1, $2, $3, $4, $5, '[2026-11-02 11:00+06, 2026-11-02 12:00+06)')`,
          [ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1, ROOM.A1x],
        );
      }),
      /lesson_sessions_teacher_excl/,
    );
  });

  it('the same classroom cannot be double-booked', async () => {
    await expectDenied(
      session(GROUP.A1b, U.teacherA1b, ROOM.A1, '[2026-11-02 11:29+06, 2026-11-02 12:00+06)'),
      /lesson_sessions_classroom_excl/,
    );
  });

  it('back-to-back sessions are allowed (half-open ranges)', async () => {
    await expect(session(GROUP.A1b, U.teacherA1b, ROOM.A1, '[2026-11-02 11:30+06, 2026-11-02 13:00+06)')).resolves.toBeDefined();
  });

  it('time zones are compared as instants: 05:00Z equals 11:00 in Bishkek', async () => {
    await expectDenied(
      session(GROUP.A1b, U.teacherA1b, ROOM.A1, '[2026-11-02 05:00Z, 2026-11-02 05:15Z)'),
      /lesson_sessions_classroom_excl/,
    );
  });

  it('cancelled sessions do not block the slot', async () => {
    await expect(
      as(db, U.adminA1, async (tx) => {
        await tx.query(`update public.lesson_sessions set status = 'cancelled', cancel_reason = 'teacher ill' where group_id = $1`, [GROUP.A1]);
        await tx.query(
          `insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period)
           values ($1, $2, $3, $4, $5, '[2026-11-02 10:00+06, 2026-11-02 11:30+06)')`,
          [ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1b, ROOM.A1],
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('a cancellation requires a reason', async () => {
    await expectDenied(
      as(db, U.adminA1, (tx) => tx.query(`update public.lesson_sessions set status = 'cancelled' where group_id = $1`, [GROUP.A1])),
      /lesson_sessions_cancel_check/,
    );
  });

  it('only teachers of the group can lead its session', async () => {
    await expectDenied(session(GROUP.A1b, U.teacherA1, ROOM.A1x, '[2026-11-05 10:00+06, 2026-11-05 11:00+06)'), /not assigned to this group/);
  });

  it('a classroom of another branch cannot be used', async () => {
    await expectDenied(session(GROUP.A1b, U.teacherA1b, ROOM.A2, '[2026-11-05 10:00+06, 2026-11-05 11:00+06)'), /foreign key/);
  });

  it('sessions need a place, a bounded duration and a non-empty range', async () => {
    await expectDenied(
      as(db, U.adminA1, (tx) =>
        tx.query(
          `insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, period)
           values ($1, $2, $3, $4, '[2026-11-06 10:00+06, 2026-11-06 11:00+06)')`,
          [ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1b],
        ),
      ),
      /lesson_sessions_place_check/,
    );
    await expectDenied(session(GROUP.A1b, U.teacherA1b, ROOM.A1x, '[2026-11-06 10:00+06, 2026-11-06 20:00+06)'), /period_check/);
    await expectDenied(session(GROUP.A1b, U.teacherA1b, ROOM.A1x, '[2026-11-06 10:00+06, 2026-11-06 10:00+06)'), /period_check/);
  });

  it('teachers and students cannot create sessions', async () => {
    for (const actor of [U.teacherA1, U.studentA1]) {
      await expectDenied(
        as(db, actor, (tx) =>
          tx.query(
            `insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period)
             values ($1, $2, $3, $4, $5, '[2026-11-07 10:00+06, 2026-11-07 11:00+06)')`,
            [ORG.A, BRANCH.A1, GROUP.A1, U.teacherA1, ROOM.A1x],
          ),
        ),
      );
    }
  });

  it('students see sessions of their own group only', async () => {
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.lesson_sessions'))).toBe(1);
    expect(await as(db, U.studentA1b, (tx) => count(tx, 'select 1 from public.lesson_sessions'))).toBe(0);
  });
});
