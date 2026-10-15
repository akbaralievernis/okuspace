import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { ASSIGN, BRANCH, GROUP, ORG, SUB, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, count, rows } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const visibleGroups = (userId: string) =>
  as(db, userId, async (tx) => (await rows<{ id: string }>(tx, 'select id from public.groups')).map((r) => r.id).sort());

describe('groups (чужая группа)', () => {
  it('each role sees exactly its groups', async () => {
    expect(await visibleGroups(U.studentA1)).toEqual([GROUP.A1]);
    expect(await visibleGroups(U.parentA1)).toEqual([GROUP.A1]);
    expect(await visibleGroups(U.teacherA1)).toEqual([GROUP.A1]);
    expect(await visibleGroups(U.adminA1)).toEqual([GROUP.A1, GROUP.A1b].sort());
    expect(await visibleGroups(U.directorA)).toEqual([GROUP.A1, GROUP.A1b, GROUP.A2].sort());
    expect(await visibleGroups(U.directorB)).toEqual([GROUP.B]);
  });

  it('a teacher cannot rename or assign themselves to a foreign group', async () => {
    const renamed = await as(db, U.teacherA1, (tx) => tx.query(`update public.groups set name = 'x' where id = $1`, [GROUP.A1b]));
    expect(renamed.affectedRows).toBe(0);
    await expectDenied(
      as(db, U.teacherA1, (tx) =>
        tx.query(`insert into public.group_teachers (organization_id, branch_id, group_id, teacher_id) values ($1, $2, $3, $4)`, [
          ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA1,
        ]),
      ),
    );
  });

  it('only teachers with an active membership in the branch can be assigned', async () => {
    await expectDenied(
      as(db, U.directorA, (tx) =>
        tx.query(`insert into public.group_teachers (organization_id, branch_id, group_id, teacher_id) values ($1, $2, $3, $4)`, [
          ORG.A, BRANCH.A1, GROUP.A1b, U.teacherA2,
        ]),
      ),
      /no active teacher membership/,
    );
  });
});

describe('enrollments', () => {
  const enrol = (actor: string, group: string, student: string, branch: string = BRANCH.A1) =>
    as(db, actor, (tx) =>
      tx.query(
        `insert into public.enrollments (organization_id, branch_id, group_id, student_id, status, created_by)
         values ($1, $2, $3, $4, 'active', $5)`,
        [ORG.A, branch, group, student, actor],
      ),
    );

  it('a student cannot enrol themselves', async () => {
    await expectDenied(enrol(U.studentA1b, GROUP.A1, U.studentA1b));
  });

  it('the same student cannot be enrolled twice (no duplicates)', async () => {
    await expectDenied(enrol(U.adminA1, GROUP.A1, U.studentA1), /duplicate key/);
  });

  it('only people with a student membership can be enrolled', async () => {
    await expectDenied(enrol(U.adminA1, GROUP.A1b, U.teacherA1), /no active student membership/);
  });

  it('group capacity is enforced', async () => {
    // GROUP.A1: capacity 2, один ученик уже записан.
    await expect(
      asMfa(db, U.adminA1, async (tx) => {
        await tx.query(
          `insert into public.enrollments (organization_id, branch_id, group_id, student_id, status, created_by) values ($1, $2, $3, $4, 'active', $5)`,
          [ORG.A, BRANCH.A1, GROUP.A1, U.studentA1b, U.adminA1],
        );
        await tx.query(
          `insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, 'student')`,
          [ORG.A, BRANCH.A1, U.outsider],
        );
        await tx.query(
          `insert into public.enrollments (organization_id, branch_id, group_id, student_id, status, created_by) values ($1, $2, $3, $4, 'active', $5)`,
          [ORG.A, BRANCH.A1, GROUP.A1, U.outsider, U.adminA1],
        );
      }),
    ).rejects.toThrow(/group is full/);
  });
});

describe('assignments and submissions (чужое домашнее задание)', () => {
  it('students see published assignments of their group only', async () => {
    const ids = await as(db, U.studentA1, async (tx) => (await rows<{ id: string }>(tx, 'select id from public.assignments')).map((r) => r.id));
    expect(ids).toEqual([ASSIGN.A1]); // черновик и чужие задания не видны
  });

  it('a student sees own submission, not a classmate’s or another branch’s', async () => {
    const ids = await as(db, U.studentA1, async (tx) =>
      (await rows<{ id: string }>(tx, 'select id from public.assignment_submissions')).map((r) => r.id),
    );
    expect(ids).toEqual([SUB.A1]);
  });

  it('a parent sees the child’s submission only', async () => {
    const ids = await as(db, U.parentA1, async (tx) =>
      (await rows<{ id: string }>(tx, 'select id from public.assignment_submissions')).map((r) => r.id),
    );
    expect(ids).toEqual([SUB.A1]);
  });

  it('a student cannot submit to an assignment of another group', async () => {
    await expectDenied(
      as(db, U.studentA1, (tx) =>
        tx.query(
          `insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body) values ($1, $2, $3, $4, 'x')`,
          [ORG.A, BRANCH.A1, ASSIGN.A1b, U.studentA1],
        ),
      ),
      /not available/,
    );
  });

  it('a student cannot submit on behalf of someone else', async () => {
    await expectDenied(
      as(db, U.studentA1, (tx) =>
        tx.query(
          `insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body) values ($1, $2, $3, $4, 'x')`,
          [ORG.A, BRANCH.A1, ASSIGN.A1b, U.studentA1b],
        ),
      ),
      // BEFORE-триггер срабатывает раньше проверки RLS WITH CHECK — подходит любой из двух отказов.
      /row-level security|only submit their own work/,
    );
  });

  it('a second submission for the same assignment is rejected (no duplicates)', async () => {
    await expectDenied(
      as(db, U.studentA1, (tx) =>
        tx.query(
          `insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body) values ($1, $2, $3, $4, 'again')`,
          [ORG.A, BRANCH.A1, ASSIGN.A1, U.studentA1],
        ),
      ),
      /duplicate key/,
    );
  });

  it('a student cannot grade own work', async () => {
    await expectDenied(
      as(db, U.studentA1, (tx) =>
        tx.query(`update public.assignment_submissions set score = 10, status = 'graded' where id = $1`, [SUB.A1]),
      ),
      /cannot grade/,
    );
  });

  it('a student can revise own work before grading', async () => {
    const result = await as(db, U.studentA1, (tx) =>
      tx.query(`update public.assignment_submissions set body = 'Revised essay' where id = $1`, [SUB.A1]),
    );
    expect(result.affectedRows).toBe(1);
  });

  it('the group teacher grades; grading metadata is set by the database', async () => {
    const graded = await as(db, U.teacherA1, async (tx) => {
      await tx.query(`update public.assignment_submissions set score = 8.5, status = 'graded', feedback = 'Good' where id = $1`, [SUB.A1]);
      return rows<{ graded_by: string; graded_at: string | null }>(tx, 'select graded_by, graded_at from public.assignment_submissions where id = $1', [SUB.A1]);
    });
    expect(graded[0]?.graded_by).toBe(U.teacherA1);
    expect(graded[0]?.graded_at).not.toBeNull();
  });

  it('a teacher cannot grade a submission of another group (IDOR)', async () => {
    const result = await as(db, U.teacherA1, (tx) =>
      tx.query(`update public.assignment_submissions set score = 1, status = 'graded' where id = $1`, [SUB.A1b]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it('a teacher cannot rewrite the student’s answer or exceed max_score', async () => {
    await expectDenied(
      as(db, U.teacherA1, (tx) => tx.query(`update public.assignment_submissions set body = 'forged' where id = $1`, [SUB.A1])),
      /cannot change the submitted work/,
    );
    await expectDenied(
      as(db, U.teacherA1, (tx) => tx.query(`update public.assignment_submissions set score = 11, status = 'graded' where id = $1`, [SUB.A1])),
      /exceeds max_score/,
    );
  });

  it('graded work is locked for the student', async () => {
    await expectDenied(
      as(db, U.teacherA1, async (tx) => {
        await tx.query(`update public.assignment_submissions set score = 9, status = 'graded' where id = $1`, [SUB.A1]);
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.studentA1, role: 'authenticated' })]);
        await tx.query(`update public.assignment_submissions set body = 'after grading' where id = $1`, [SUB.A1]);
      }),
      /graded work cannot be changed/,
    );
  });

  it('a director reads all submissions of the organization, not of others', async () => {
    expect(await as(db, U.directorA, (tx) => count(tx, 'select 1 from public.assignment_submissions'))).toBe(3);
  });
});
