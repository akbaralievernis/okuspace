import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

/**
 * Блок B: задания отдельным ученикам, офлайн-экзамены, правила оценивания
 * и итоги месяца (расчёт сверяется с вручную посчитанными значениями).
 */
let db: PGlite;
const now = new Date();
// Прошлый месяц: все события — в середине месяца, чтобы не зависеть от часового пояса.
const MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
const day = (d: number, h = 6) => `${MONTH.slice(0, 8)}${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const TEST = 'e3000000-0000-4000-8000-000000000001';
const EXAM_PAST = 'e3000000-0000-4000-8000-000000000002';
const HW_GROUP = 'e3000000-0000-4000-8000-000000000003';
const HW_ONE = 'e3000000-0000-4000-8000-000000000004';

beforeAll(async () => {
  db = await createSeededDb();
  // В группе A1 два ученика: studentA1 (с опекуном parentA1) и studentA1b.
  await db.exec(`
    insert into public.enrollments (organization_id, branch_id, group_id, student_id, status)
      values ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.studentA1b}', 'active');

    -- Данные прошлого месяца для итога: 2 занятия, 2 домашних (одно — только studentA1b), тест, экзамен.
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period, status) values
      ('e3000000-0000-4000-8000-000000000011', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${day(10)}', '${day(10, 7)}'), 'done'),
      ('e3000000-0000-4000-8000-000000000012', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange('${day(12)}', '${day(12, 7)}'), 'done');
    insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, absence_reason, source, marked_by) values
      ('${ORG.A}', '${BRANCH.A1}', 'e3000000-0000-4000-8000-000000000011', '${U.studentA1}', 'present', null, 'teacher', '${U.teacherA1}'),
      ('${ORG.A}', '${BRANCH.A1}', 'e3000000-0000-4000-8000-000000000012', '${U.studentA1}', 'absent', null, 'teacher', '${U.teacherA1}'),
      ('${ORG.A}', '${BRANCH.A1}', 'e3000000-0000-4000-8000-000000000011', '${U.studentA1b}', 'present', null, 'teacher', '${U.teacherA1}'),
      ('${ORG.A}', '${BRANCH.A1}', 'e3000000-0000-4000-8000-000000000012', '${U.studentA1b}', 'excused', 'illness', 'teacher', '${U.teacherA1}');

    insert into public.assignments (id, organization_id, branch_id, group_id, title, due_at, max_score, status, created_by, created_at) values
      ('${HW_GROUP}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', 'Month essay', '${day(14)}', 10, 'draft', '${U.teacherA1}', '${day(5)}'),
      ('${HW_ONE}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', 'Extra task', '${day(15)}', 10, 'draft', '${U.teacherA1}', '${day(5)}');
    insert into public.assignment_students (assignment_id, student_id, organization_id) values ('${HW_ONE}', '${U.studentA1b}', '${ORG.A}');
    update public.assignments set status = 'published' where id in ('${HW_GROUP}', '${HW_ONE}');
    insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body, status, score) values
      ('${ORG.A}', '${BRANCH.A1}', '${HW_GROUP}', '${U.studentA1}', 'essay', 'graded', 8),
      ('${ORG.A}', '${BRANCH.A1}', '${HW_ONE}', '${U.studentA1b}', 'extra', 'graded', 10);

    insert into public.assessments (id, organization_id, course_id, title, max_attempts, reveal_answers, status) values
      ('${TEST}', '${ORG.A}', '${COURSE.A}', 'Month test', 3, 'after_submit', 'published');
    insert into public.group_assessments (organization_id, branch_id, group_id, assessment_id, opens_at, due_at) values
      ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${TEST}', '${day(8)}', '${day(20)}');
    insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key, submitted_at) values
      ('${ORG.A}', '${TEST}', '${U.studentA1}', 1, 6, 10, gen_random_uuid(), '${day(9)}'),
      ('${ORG.A}', '${TEST}', '${U.studentA1}', 2, 9, 10, gen_random_uuid(), '${day(9, 8)}');

    insert into public.group_exams (id, organization_id, branch_id, group_id, title, held_on, max_score, status, created_by) values
      ('${EXAM_PAST}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', 'Month exam', '${MONTH.slice(0, 8)}25', 100, 'draft', '${U.teacherA1}');
    insert into public.exam_results (exam_id, student_id, organization_id, score, absent) values
      ('${EXAM_PAST}', '${U.studentA1}', '${ORG.A}', 70, false), ('${EXAM_PAST}', '${U.studentA1b}', '${ORG.A}', null, true);
    update public.group_exams set status = 'published' where id = '${EXAM_PAST}';
  `);
}, 60_000);

const sees = (u: string, sql: string, params: unknown[] = []) => as(db, u, (tx) => count(tx, sql, params));
const notes = (u: string, kind: string, like = '%') => count(db, 'select 1 from public.notifications where recipient_id = $1 and kind = $2 and dedupe_key like $3', [u, kind, like]);

describe('assignments for selected students', () => {
  const create = (tx: Tx, students: string[], title = 'Personal task') =>
    tx.query<{ id: string }>(`select public.assignment_create($1, $2, 'Do it', now() + interval '3 days', 10, $3) as id`, [GROUP.A1, title, students]);

  it('only targeted students and their guardians see, get notified and can submit', async () => {
    const id = (await as(db, U.teacherA1, (tx) => create(tx, [U.studentA1b]), { commit: true })).rows[0]!.id;
    const q = 'select 1 from public.assignments where id = $1';
    expect(await sees(U.studentA1b, q, [id])).toBe(1);
    expect(await sees(U.studentA1, q, [id])).toBe(0);
    expect(await sees(U.parentA1, q, [id])).toBe(0); // опекун studentA1, а адресат — studentA1b
    expect(await sees(U.teacherA1, q, [id])).toBe(1);
    expect(await sees(U.managerA1, q, [id])).toBe(1); // learning.read_all
    expect(await notes(U.studentA1b, 'homework_assigned', `%${id}%`)).toBe(1);
    expect(await notes(U.studentA1, 'homework_assigned', `%${id}%`)).toBe(0);
    const submit = (u: string) =>
      as(db, u, (tx) => tx.query(`insert into public.assignment_submissions (organization_id, branch_id, assignment_id, student_id, body) values ($1, $2, $3, $4, 'answer')`, [ORG.A, BRANCH.A1, id, u]));
    await expectDenied(submit(U.studentA1), /not available/);
    await submit(U.studentA1b);
    expect(await sees(U.studentA1, 'select 1 from public.assignment_students where assignment_id = $1', [id])).toBe(0);
  });

  it('an empty list means the whole group; only group teachers create; students must be active in the group', async () => {
    const id = (await as(db, U.teacherA1, (tx) => create(tx, [], 'Group task'), { commit: true })).rows[0]!.id;
    expect(await sees(U.studentA1, 'select 1 from public.assignments where id = $1', [id])).toBe(1);
    expect(await sees(U.parentA1, 'select 1 from public.assignments where id = $1', [id])).toBe(1);
    expect(await notes(U.studentA1, 'homework_assigned', `%${id}%`)).toBe(1);
    await expectDenied(as(db, U.teacherA1b, (tx) => create(tx, [])), /not allowed/);
    await expectDenied(as(db, U.studentA1, (tx) => create(tx, [])), /not allowed/);
    await expectDenied(as(db, U.teacherA1, (tx) => create(tx, [U.studentA2])), /active in this group/);
  });
});

describe('offline exams', () => {
  const EXAM = randomUUID();
  const result = (tx: Tx, student: string, score: number | null, absent = false) =>
    tx.query(`insert into public.exam_results (exam_id, student_id, organization_id, score, absent) values ($1, $2, $3, $4, $5)
              on conflict (exam_id, student_id) do update set score = excluded.score, absent = excluded.absent`, [EXAM, student, ORG.A, score, absent]);

  it('the group teacher enters scores; limits are enforced', async () => {
    await as(db, U.teacherA1, (tx) =>
      tx.query(`insert into public.group_exams (id, organization_id, branch_id, group_id, title, held_on, max_score, created_by) values ($1, $2, $3, $4, 'Speaking exam', current_date, 50, $5)`,
        [EXAM, ORG.A, BRANCH.A1, GROUP.A1, U.teacherA1]), { commit: true });
    await as(db, U.teacherA1, (tx) => result(tx, U.studentA1, 40), { commit: true });
    await as(db, U.teacherA1, (tx) => result(tx, U.studentA1b, null, true), { commit: true });
    await expectDenied(as(db, U.teacherA1, (tx) => result(tx, U.studentA1, 60)), /exceeds max_score/);
    await expectDenied(as(db, U.teacherA1, (tx) => result(tx, U.studentA2, 10)), /not in this group/);
    await expectDenied(as(db, U.teacherA1, (tx) => result(tx, U.studentA1, 10, true)), /absent_check/);
    await expectDenied(as(db, U.teacherA1b, (tx) => result(tx, U.studentA1, 10)));
    // Upsert в стиле PostgREST (все столбцы в SET) проходит; переписать ученика или экзамен — нет.
    await as(db, U.teacherA1, (tx) => tx.query(`insert into public.exam_results (exam_id, student_id, organization_id, score, absent) values ($1, $2, $3, 41, false)
      on conflict (exam_id, student_id) do update set exam_id = excluded.exam_id, student_id = excluded.student_id, organization_id = excluded.organization_id, score = excluded.score, absent = excluded.absent`, [EXAM, U.studentA1, ORG.B]));
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query(`update public.exam_results set student_id = $1 where exam_id = $2 and student_id = $3`, [U.studentA2, EXAM, U.studentA1])), /immutable/);
    await expectDenied(as(db, U.studentA1, (tx) => result(tx, U.studentA1, 50)));
    await expectDenied(as(db, U.teacherA1b, (tx) =>
      tx.query(`insert into public.group_exams (organization_id, branch_id, group_id, title, held_on, max_score, created_by) values ($1, $2, $3, 'X exam', current_date, 10, $4)`,
        [ORG.A, BRANCH.A1, GROUP.A1, U.teacherA1b])));
  });

  it('students and guardians see only their own results and only after publication', async () => {
    const own = 'select 1 from public.exam_results where exam_id = $1';
    expect(await sees(U.studentA1, own, [EXAM])).toBe(0);
    expect(await sees(U.studentA1, 'select 1 from public.group_exams where id = $1', [EXAM])).toBe(0);
    await as(db, U.teacherA1, (tx) => tx.query(`update public.group_exams set status = 'published' where id = $1`, [EXAM]), { commit: true });
    expect(await sees(U.studentA1, own, [EXAM])).toBe(1);
    expect(await sees(U.studentA1b, own, [EXAM])).toBe(1);
    expect(await sees(U.parentA1, own, [EXAM])).toBe(1); // только результат своего ребёнка
    expect(await sees(U.teacherA1, own, [EXAM])).toBe(2);
    expect(await sees(U.studentA2, own, [EXAM])).toBe(0);
    for (const u of [U.studentA1, U.parentA1, U.studentA1b]) expect(await notes(u, 'exam_result', `%${EXAM}%`), u).toBe(1);
  });

  it('a published exam keeps its maximum; corrections are audited', async () => {
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query(`update public.group_exams set status = 'draft' where id = $1`, [EXAM])), /cannot be changed/);
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query(`update public.group_exams set max_score = 100 where id = $1`, [EXAM])), /cannot be changed/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.group_exams where id = $1`, [EXAM])), /cannot be deleted/);
    await as(db, U.teacherA1, (tx) => tx.query(`update public.exam_results set score = 45 where exam_id = $1 and student_id = $2`, [EXAM, U.studentA1]), { commit: true });
    const audit = await rows<{ diff: { student_id: string; score: { old: number; new: number } }; actor_id: string }>(db,
      `select diff, actor_id from public.audit_logs where entity = 'exam_results' and entity_id = $1`, [EXAM]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(U.teacherA1);
    expect(audit[0]!.diff.student_id).toBe(U.studentA1);
    expect(Number(audit[0]!.diff.score.old)).toBe(40);
    expect(Number(audit[0]!.diff.score.new)).toBe(45);
  });
});

describe('monthly report cards', () => {
  type Card = { student_id: string; attendance_pct: string | null; homework_pct: string | null; tests_pct: string | null; exam_pct: string | null; final_pct: string | null; grade: number | null; status: string };
  const generate = (u: string, month = MONTH) => as(db, u, (tx) => tx.query<{ n: number }>('select public.report_cards_generate($1, $2) as n', [GROUP.A1, month]), { commit: true });
  const card = async (student: string) =>
    (await rows<Card>(db, 'select student_id, attendance_pct, homework_pct, tests_pct, exam_pct, final_pct, grade, status from public.report_cards where group_id = $1 and month = $2 and student_id = $3', [GROUP.A1, MONTH, student]))[0]!;
  const num = (v: string | null) => (v === null ? null : Number(v));

  it('computes each part and the weighted result from source data', async () => {
    expect((await generate(U.teacherA1)).rows[0]!.n).toBe(2);
    const a = await card(U.studentA1);
    // посещаемость 1 из 2; домашнее 8/10; тест — лучшая попытка 9/10; экзамен 70/100; итог (50·20+80·30+90·20+70·30)/100
    expect([a.attendance_pct, a.homework_pct, a.tests_pct, a.exam_pct].map(num)).toEqual([50, 80, 90, 70]);
    expect(num(a.final_pct)).toBe(73);
    expect(a.grade).toBe(3);
    expect(a.status).toBe('draft');
    const b = await card(U.studentA1b);
    // уважительная причина не считается; общее задание не сдано после срока = 0, личное 10/10; тест не пройден = 0; экзамен — не пришёл = 0
    expect([b.attendance_pct, b.homework_pct, b.tests_pct, b.exam_pct].map(num)).toEqual([100, 50, 0, 0]);
    expect(num(b.final_pct)).toBe(35);
    expect(b.grade).toBe(2);
  });

  it('five-point scale boundaries: 90 → 5, 75 → 4, 60 → 3, below → 2', async () => {
    const g = await rows<{ p: string; g: number | null }>(db,
      `select p::text, app.five_point(p) as g from unnest(array[100, 90, 89.99, 75, 74.99, 60, 59.99, 0]::numeric[]) p`);
    expect(g.map((r) => r.g)).toEqual([5, 5, 4, 4, 3, 3, 2, 2]);
    expect((await rows<{ g: number | null }>(db, 'select app.five_point(null) as g'))[0]!.g).toBeNull();
  });

  it('only teachers of the group or group managers generate; drafts are hidden from students', async () => {
    await expectDenied(generate(U.teacherA1b), /not allowed/);
    await expectDenied(generate(U.studentA1), /not allowed/);
    await expectDenied(generate(U.teacherA1, `${MONTH.slice(0, 8)}15`), /invalid month/);
    await expectDenied(generate(U.teacherA1, '2999-01-01'), /invalid month/);
    expect((await generate(U.managerA1)).rows[0]!.n).toBe(2);
    expect(await sees(U.studentA1, 'select 1 from public.report_cards')).toBe(0);
    expect(await sees(U.parentA1, 'select 1 from public.report_cards')).toBe(0);
    expect(await sees(U.teacherA1, 'select 1 from public.report_cards where group_id = $1', [GROUP.A1])).toBe(2);
    expect(await sees(U.teacherA1b, 'select 1 from public.report_cards where group_id = $1', [GROUP.A1])).toBe(0);
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query(`update public.report_cards set final_pct = 100`)));
  });

  it('the school policy changes weights and scale; parts without data are skipped', async () => {
    await expectDenied(as(db, U.directorA, (tx) => tx.query(`insert into public.grading_policies (organization_id, weight_attendance, weight_homework, weight_tests, weight_exam, scale) values ($1, 0, 50, 0, 50, 'percent')`, [ORG.A])));
    await expectDenied(asMfa(db, U.managerA1, (tx) => tx.query(`insert into public.grading_policies (organization_id, weight_attendance, weight_homework, weight_tests, weight_exam) values ($1, 0, 50, 0, 50)`, [ORG.A])));
    await expectDenied(asMfa(db, U.directorA, (tx) => tx.query(`insert into public.grading_policies (organization_id, weight_attendance, weight_homework, weight_tests, weight_exam) values ($1, 10, 50, 0, 50)`, [ORG.A])), /sum_check/);
    await asMfa(db, U.directorA, (tx) => tx.query(`insert into public.grading_policies (organization_id, weight_attendance, weight_homework, weight_tests, weight_exam, scale) values ($1, 0, 50, 0, 50, 'percent')`, [ORG.A]), { commit: true });
    expect(await sees(U.teacherA1, 'select 1 from public.grading_policies')).toBe(1);
    await generate(U.teacherA1);
    const a = await card(U.studentA1);
    expect(num(a.final_pct)).toBe(75); // (80·50 + 70·50) / 100
    expect(a.grade).toBeNull(); // шкала «проценты»
    await asMfa(db, U.directorA, (tx) => tx.query(`update public.grading_policies set weight_attendance = 20, weight_homework = 30, weight_tests = 20, weight_exam = 30, scale = 'five' where organization_id = $1`, [ORG.A]), { commit: true });
    await generate(U.teacherA1);
    expect(num((await card(U.studentA1)).final_pct)).toBe(73);
  });

  it('publication shows each card to the student and guardians and freezes it', async () => {
    const id = (await rows<{ id: string }>(db, 'select id from public.report_cards where group_id = $1 and month = $2 and student_id = $3', [GROUP.A1, MONTH, U.studentA1]))[0]!.id;
    await expectDenied(as(db, U.teacherA1b, (tx) => tx.query(`select public.report_card_comment($1, 'чужой')`, [id])), /not allowed/);
    await as(db, U.teacherA1, (tx) => tx.query(`select public.report_card_comment($1, 'Больше говорить на уроках')`, [id]), { commit: true });
    await expectDenied(as(db, U.studentA1, (tx) => tx.query('select public.report_cards_publish($1, $2)', [GROUP.A1, MONTH])), /not allowed/);
    expect((await as(db, U.teacherA1, (tx) => tx.query<{ n: number }>('select public.report_cards_publish($1, $2) as n', [GROUP.A1, MONTH]), { commit: true })).rows[0]!.n).toBe(2);
    expect(await sees(U.studentA1, 'select 1 from public.report_cards')).toBe(1);
    expect(await sees(U.studentA1b, 'select 1 from public.report_cards')).toBe(1);
    expect(await sees(U.parentA1, 'select 1 from public.report_cards where student_id = $1', [U.studentA1])).toBe(1);
    expect(await sees(U.parentA1, 'select 1 from public.report_cards where student_id = $1', [U.studentA1b])).toBe(0);
    for (const u of [U.studentA1, U.parentA1, U.studentA1b]) expect(await notes(u, 'report_card'), u).toBe(1);
    expect((await rows<{ c: string }>(db, 'select teacher_comment c from public.report_cards where id = $1', [id]))[0]!.c).toBe('Больше говорить на уроках');

    // Опубликованный табель не меняется: ни пересчётом, ни комментарием, ни напрямую.
    await db.exec(`update public.assignment_submissions set score = 2 where assignment_id = '${HW_GROUP}' and student_id = '${U.studentA1}'`);
    await generate(U.teacherA1);
    expect(num((await card(U.studentA1)).final_pct)).toBe(73);
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query(`select public.report_card_comment($1, 'новый')`, [id])), /immutable/);
    await expectDenied(asService(db, (tx) => tx.query(`update public.report_cards set grade = 5 where id = $1`, [id])), /immutable/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.report_cards where id = $1`, [id])), /immutable/);
  });

  it('at the start of a month drafts appear automatically and teachers are told; users cannot run it', async () => {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 6)).toISOString(); // 2-е число текущего месяца
    const prev2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    const run = (at: string) => asService(db, (tx) => tx.query<{ r: { groups: number } }>('select public.generate_monthly_reports($1) as r', [at]), { commit: true });
    expect((await run(next)).rows[0]!.r.groups).toBeGreaterThanOrEqual(1);
    await run(next);
    expect(await notes(U.teacherA1, 'report_cards_ready', `%${GROUP.A1}:${MONTH.slice(0, 7)}`)).toBe(1);
    // В середине месяца — ничего.
    expect((await run(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 6)).toISOString())).rows[0]!.r.groups).toBe(0);
    expect(await count(db, 'select 1 from public.report_cards where month = $1', [prev2])).toBe(0);
    await expectDenied(as(db, U.directorA, (tx) => tx.query('select public.generate_monthly_reports()')), /permission denied/);
  });
});
