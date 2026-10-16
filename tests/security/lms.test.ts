import type { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, COURSE, GROUP, ORG, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

/**
 * LMS (этап 5): доступ к материалам, закрытые ключи ответов, серверная проверка,
 * идемпотентность, лимит попыток и пересдачи, раскрытие ответов, прогресс.
 */
let db: PGlite;
const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const M1 = id(1); // опубликованный модуль
const M2 = id(2); // черновик модуля
const L1 = id(11); // опубликован
const L2 = id(12); // черновик
const L3 = id(13); // опубликован
const L4 = id(14); // опубликован, но модуль — черновик
const T1 = id(21); // тест: показать ответы сразу, 1 попытка, назначен группе A1
const T2 = id(22); // тест: ответы после срока, назначен группе A1
const T3 = id(23); // черновик
const Q = { single: id(31), multi: id(32), text: id(33), gaps: id(34), t2: id(35), t3: id(36) };

const ALL_CORRECT = {
  [Q.single]: { option: 'b' },
  [Q.multi]: { options: ['c', 'a'] },
  [Q.text]: { text: '  WENT ' },
  [Q.gaps]: { gaps: ['is', 'are'] },
};

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.course_modules (id, organization_id, course_id, title, position, status) values
      ('${M1}', '${ORG.A}', '${COURSE.A}', 'Unit 1', 1, 'published'), ('${M2}', '${ORG.A}', '${COURSE.A}', 'Unit 2', 2, 'draft');
    insert into public.lessons (id, organization_id, course_id, module_id, title, position, status) values
      ('${L1}', '${ORG.A}', '${COURSE.A}', '${M1}', 'Greetings', 1, 'published'),
      ('${L2}', '${ORG.A}', '${COURSE.A}', '${M1}', 'Draft lesson', 2, 'draft'),
      ('${L3}', '${ORG.A}', '${COURSE.A}', '${M1}', 'Numbers', 3, 'published'),
      ('${L4}', '${ORG.A}', '${COURSE.A}', '${M2}', 'Hidden by module', 1, 'published');
    insert into public.lesson_blocks (organization_id, course_id, lesson_id, position, type, content) values
      ('${ORG.A}', '${COURSE.A}', '${L1}', 1, 'text', '{"body": "Hello!"}'),
      ('${ORG.A}', '${COURSE.A}', '${L1}', 2, 'vocabulary', '{"items": [{"term": "hello", "meaning": "привет"}]}');
    insert into public.assessments (id, organization_id, course_id, lesson_id, title, max_attempts, reveal_answers, status) values
      ('${T1}', '${ORG.A}', '${COURSE.A}', '${L1}', 'Quiz 1', 1, 'after_submit', 'published'),
      ('${T2}', '${ORG.A}', '${COURSE.A}', null, 'Test after due', 2, 'after_due', 'published'),
      ('${T3}', '${ORG.A}', '${COURSE.A}', null, 'Draft test', 1, 'after_submit', 'draft');
    insert into public.assessment_questions (id, organization_id, course_id, assessment_id, position, type, prompt, options, points, explanation) values
      ('${Q.single}', '${ORG.A}', '${COURSE.A}', '${T1}', 1, 'single_choice', 'Pick b', '[{"id":"a","text":"A"},{"id":"b","text":"B"}]', 2, 'Because b'),
      ('${Q.multi}', '${ORG.A}', '${COURSE.A}', '${T1}', 2, 'multiple_choice', 'Pick a and c', '[{"id":"a","text":"A"},{"id":"b","text":"B"},{"id":"c","text":"C"}]', 1, null),
      ('${Q.text}', '${ORG.A}', '${COURSE.A}', '${T1}', 3, 'short_text', 'Past of go', '[]', 1, null),
      ('${Q.gaps}', '${ORG.A}', '${COURSE.A}', '${T1}', 4, 'gap_fill', 'He __ / they __', '[]', 2, null),
      ('${Q.t2}', '${ORG.A}', '${COURSE.A}', '${T2}', 1, 'short_text', 'Capital of KG', '[]', 1, 'Bishkek'),
      ('${Q.t3}', '${ORG.A}', '${COURSE.A}', '${T3}', 1, 'short_text', 'Draft q', '[]', 1, null);
    insert into public.assessment_answer_keys (question_id, organization_id, key) values
      ('${Q.single}', '${ORG.A}', '{"option": "b"}'),
      ('${Q.multi}', '${ORG.A}', '{"options": ["a", "c"]}'),
      ('${Q.text}', '${ORG.A}', '{"accepted": ["went"]}'),
      ('${Q.gaps}', '${ORG.A}', '{"gaps": [["is"], ["are"]]}'),
      ('${Q.t2}', '${ORG.A}', '{"accepted": ["Bishkek", "Бишкек"]}'),
      ('${Q.t3}', '${ORG.A}', '{"accepted": ["x"]}');
    insert into public.group_assessments (organization_id, branch_id, group_id, assessment_id, opens_at, due_at) values
      ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${T1}', now() - interval '1 hour', null),
      ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${T2}', now() - interval '1 hour', now() + interval '7 days');
  `);
}, 60_000);

const submit = (tx: Tx, assessment: string, answers: object, key: string = randomUUID()) =>
  tx.query<{ id: string }>('select public.submit_assessment_attempt($1, $2, $3) as id', [assessment, JSON.stringify(answers), key]);

describe('grading function (app.grade_answer)', () => {
  const grade = async (type: string, key: object, answer: object) =>
    Number((await rows<{ g: string }>(db, 'select app.grade_answer($1, $2, $3)::text as g', [type, JSON.stringify(key), JSON.stringify(answer)]))[0]!.g);

  it('normalises case and spaces in text answers', async () => {
    expect(await grade('short_text', { accepted: ['had gone'] }, { text: '  Had   GONE ' })).toBe(1);
    expect(await grade('short_text', { accepted: ['went'] }, { text: 'go' })).toBe(0);
  });

  it('multiple choice is order-insensitive and all-or-nothing', async () => {
    expect(await grade('multiple_choice', { options: ['a', 'c'] }, { options: ['c', 'a'] })).toBe(1);
    expect(await grade('multiple_choice', { options: ['a', 'c'] }, { options: ['a'] })).toBe(0);
    expect(await grade('multiple_choice', { options: ['a', 'c'] }, { options: ['a', 'b', 'c'] })).toBe(0);
  });

  it('gap fill gives partial credit; malformed answers score zero', async () => {
    expect(await grade('gap_fill', { gaps: [['is'], ['are']] }, { gaps: ['is', 'is'] })).toBe(0.5);
    expect(await grade('gap_fill', { gaps: [['is'], ['are']] }, { gaps: 'is are' })).toBe(0);
    expect(await grade('single_choice', { option: 'b' }, {})).toBe(0);
  });
});

describe('course content access', () => {
  const lessonsSeen = (user: string) => as(db, user, async (tx) => (await rows<{ id: string }>(tx, 'select id from public.lessons order by id')).map((r) => r.id));

  it('enrolled students see only published lessons in published modules', async () => {
    expect(await lessonsSeen(U.studentA1)).toEqual([L1, L3]);
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.course_modules'))).toBe(1);
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.lesson_blocks'))).toBe(2);
  });

  it('course teachers and catalog managers see drafts; guardians and supervisors see published', async () => {
    for (const editor of [U.teacherA1, U.teacherA2, U.directorA]) expect(await lessonsSeen(editor), editor).toEqual([L1, L2, L3, L4]);
    expect(await lessonsSeen(U.parentA1)).toEqual([L1, L3]);
    expect(await lessonsSeen(U.managerA1)).toEqual([L1, L3]); // learning.read_all
  });

  it('people without a relation to the course see nothing', async () => {
    for (const user of [U.studentB, U.teacherB, U.outsider, U.adminA1, U.accountantA]) expect(await lessonsSeen(user), user).toEqual([]);
  });

  it('only course editors write content', async () => {
    const addLesson = (tx: Tx) =>
      tx.query(`insert into public.lessons (organization_id, course_id, module_id, title, position) values ($1, $2, $3, 'New', 9)`, [ORG.A, COURSE.A, M1]);
    await expect(as(db, U.teacherA1, addLesson)).resolves.toBeDefined();
    for (const user of [U.studentA1, U.teacherB, U.adminA1]) await expectDenied(as(db, user, addLesson));
    const r = await as(db, U.studentA1, (tx) => tx.query(`update public.lessons set title = 'hacked' where id = $1`, [L1]));
    expect(r.affectedRows).toBe(0);
  });

  it('block content is validated by type', async () => {
    const block = (type: string, content: object) => (tx: Tx) =>
      tx.query(`insert into public.lesson_blocks (organization_id, course_id, lesson_id, position, type, content) values ($1, $2, $3, 9, $4, $5)`, [
        ORG.A, COURSE.A, L1, type, JSON.stringify(content),
      ]);
    await expectDenied(as(db, U.teacherA1, block('video', { url: 'http://insecure.example/v.mp4' })), /https url/);
    await expectDenied(as(db, U.teacherA1, block('vocabulary', { items: [{ term: 'x' }] })), /term and meaning/);
    await expectDenied(as(db, U.teacherA1, block('text', { html: '<script>' })), /text body/);
    await expect(as(db, U.teacherA1, block('audio', { url: 'https://cdn.example/a.mp3' }))).resolves.toBeDefined();
  });
});

describe('answer keys stay hidden', () => {
  it('students and guardians cannot read keys; editors can', async () => {
    for (const user of [U.studentA1, U.parentA1, U.managerA1]) {
      expect(await as(db, user, (tx) => count(tx, 'select 1 from public.assessment_answer_keys')), user).toBe(0);
    }
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.assessment_answer_keys'))).toBe(6);
  });

  it('students see questions only of tests assigned and open for their group, without correctness', async () => {
    const qs = await as(db, U.studentA1, (tx) => rows<{ assessment_id: string; options: object }>(tx, 'select assessment_id, options from public.assessment_questions'));
    expect(new Set(qs.map((q) => q.assessment_id))).toEqual(new Set([T1, T2]));
    expect(JSON.stringify(qs)).not.toMatch(/correct|"key"|accepted/);
    // Ученик другой группы того же курса — тест его группе не назначен.
    expect(await as(db, U.studentA1b, (tx) => count(tx, 'select 1 from public.assessment_questions'))).toBe(0);
  });
});

describe('submitting attempts', () => {
  it('grades on the server, is idempotent, and enforces the attempt limit', async () => {
    const result = await as(db, U.studentA1, async (tx) => {
      const key = randomUUID();
      const first = (await submit(tx, T1, ALL_CORRECT, key)).rows[0]!.id;
      const again = (await submit(tx, T1, ALL_CORRECT, key)).rows[0]!.id; // повторная отправка той же формы
      const attempts = await rows<{ score: string; max_score: string; attempt_no: number }>(
        tx,
        'select score::text, max_score::text, attempt_no from public.assessment_attempts where assessment_id = $1',
        [T1],
      );
      return { first, again, attempts };
    });
    expect(result.again).toBe(result.first);
    expect(result.attempts).toEqual([{ score: '6.00', max_score: '6.00', attempt_no: 1 }]);

    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await submit(tx, T1, ALL_CORRECT);
        await submit(tx, T1, ALL_CORRECT);
      }),
      /no attempts left/,
    );
  });

  it('gives partial credit and ignores answers to foreign questions', async () => {
    const score = await as(db, U.studentA1, async (tx) => {
      const attempt = (await submit(tx, T1, { [Q.single]: { option: 'a' }, [Q.gaps]: { gaps: ['is', 'x'] }, [Q.t3]: { text: 'x' } })).rows[0]!.id;
      return rows<{ score: string; n: number }>(
        tx,
        `select a.score::text, (select count(*)::int from public.attempt_answers where attempt_id = a.id) as n from public.assessment_attempts a where a.id = $1`,
        [attempt],
      );
    });
    expect(score).toEqual([{ score: '1.00', n: 4 }]); // только половина gap_fill (2 × 0.5)
  });

  it('cannot be forged: no direct inserts, no updates, no deletes', async () => {
    await expectDenied(
      as(db, U.studentA1, (tx) =>
        tx.query(`insert into public.assessment_attempts (organization_id, assessment_id, student_id, attempt_no, score, max_score, idempotency_key) values ($1, $2, $3, 1, 6, 6, $4)`, [
          ORG.A, T1, U.studentA1, randomUUID(),
        ]),
      ),
      /permission denied/,
    );
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await submit(tx, T1, {});
        await tx.query('update public.assessment_attempts set score = 6');
      }),
      /permission denied/,
    );
    await expectDenied(
      asService(db, async (tx) => {
        await tx.exec('reset role');
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.studentA1, role: 'authenticated' })]);
        await tx.exec('set local role authenticated');
        await submit(tx, T1, {});
        await tx.exec('set local role service_role');
        await tx.query('delete from public.assessment_attempts');
      }),
      /append-only/,
    );
  });

  it('only students of an assigned group can submit; drafts and anonymous never', async () => {
    await expectDenied(as(db, U.studentA1b, (tx) => submit(tx, T1, ALL_CORRECT)), /not available/);
    await expectDenied(as(db, U.studentA1, (tx) => submit(tx, T3, {})), /not available/);
    await expectDenied(as(db, U.teacherA1, (tx) => submit(tx, T1, ALL_CORRECT)), /not available/);
    await expectDenied(as(db, null, (tx) => submit(tx, T1, ALL_CORRECT)), /permission denied/);
  });

  it('an idempotency key cannot be reused to read another student attempt', async () => {
    const key = randomUUID();
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await submit(tx, T2, { [Q.t2]: { text: 'bishkek' } }, key);
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.parentA1, role: 'authenticated' })]);
        await submit(tx, T2, {}, key);
      }),
      /another attempt/,
    );
  });
});

describe('retakes ("назначить повторно")', () => {
  const grant = (teacher: string) => (tx: Tx) =>
    tx.query(`insert into public.assessment_retakes (organization_id, assessment_id, student_id, extra_attempts, reason, granted_by) values ($1, $2, $3, 1, 'second try', $4)`, [
      ORG.A, T1, U.studentA1, teacher,
    ]);

  it('the student’s group teacher can grant one more attempt; others cannot', async () => {
    await expectDenied(as(db, U.teacherA2, grant(U.teacherA2))); // преподаёт курс, но не этому ученику
    await expectDenied(as(db, U.studentA1, grant(U.studentA1)));
    const attempts = await as(db, U.teacherA1, async (tx) => {
      await grant(U.teacherA1)(tx);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.studentA1, role: 'authenticated' })]);
      await submit(tx, T1, ALL_CORRECT);
      await submit(tx, T1, ALL_CORRECT);
      return count(tx, 'select 1 from public.assessment_attempts where assessment_id = $1', [T1]);
    });
    expect(attempts).toBe(2);
  });
});

describe('reviewing answers', () => {
  const review = (user: string, assessment: string, answers: object) =>
    as(db, U.studentA1, async (tx) => {
      const attempt = (await submit(tx, assessment, answers)).rows[0]!.id;
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
      return (await tx.query<{ r: { answersRevealed: boolean; questions: { key: unknown; explanation: unknown; isCorrect: boolean }[] } }>(
        'select public.attempt_review($1) as r',
        [attempt],
      )).rows[0]!.r;
    });

  it('after_submit: the student sees keys and explanations right away', async () => {
    const r = await review(U.studentA1, T1, ALL_CORRECT);
    expect(r.answersRevealed).toBe(true);
    expect(r.questions[0]).toMatchObject({ key: { option: 'b' }, explanation: 'Because b', isCorrect: true });
  });

  it('after_due: keys stay hidden for student and guardian until the due date; the teacher sees them', async () => {
    const student = await review(U.studentA1, T2, { [Q.t2]: { text: 'Osh' } });
    expect(student.answersRevealed).toBe(false);
    expect(student.questions[0]).toMatchObject({ key: null, explanation: null, isCorrect: false });
    expect((await review(U.parentA1, T2, {})).questions[0]!.key).toBeNull();
    expect((await review(U.teacherA1, T2, {})).questions[0]!.key).toEqual({ accepted: ['Bishkek', 'Бишкек'] });
  });

  it('after the due date passes, keys are revealed to the student', async () => {
    await db.exec(`update public.group_assessments set due_at = now() - interval '1 minute', opens_at = now() - interval '2 hours' where assessment_id = '${T2}'`);
    try {
      const r = await as(db, U.studentA1, async (tx) => {
        // Срок прошёл, но тест открыт — сдача после срока разрешена, отметка времени фиксируется.
        const attempt = (await submit(tx, T2, { [Q.t2]: { text: 'бишкек' } })).rows[0]!.id;
        return (await tx.query<{ r: { answersRevealed: boolean } }>('select public.attempt_review($1) as r', [attempt])).rows[0]!.r;
      });
      expect(r.answersRevealed).toBe(true);
    } finally {
      await db.exec(`update public.group_assessments set due_at = now() + interval '7 days' where assessment_id = '${T2}'`);
    }
  });

  it('other students cannot review someone else’s attempt', async () => {
    await expectDenied(review(U.studentA1b, T1, ALL_CORRECT), /attempt not found/);
    await expectDenied(review(U.teacherB, T1, ALL_CORRECT), /attempt not found/);
  });
});

describe('assigning tests to groups', () => {
  const assign = (user: string, group: string, assessment: string, branch: string = BRANCH.A1) => (tx: Tx) =>
    tx.query(`insert into public.group_assessments (organization_id, branch_id, group_id, assessment_id, assigned_by) values ($1, $2, $3, $4, $5)`, [
      ORG.A, branch, group, assessment, user,
    ]);

  it('only teachers of the group (or group managers) assign, and only published tests of the group course', async () => {
    await expectDenied(as(db, U.teacherA1, assign(U.teacherA1, GROUP.A1b, T1))); // не его группа
    await expect(as(db, U.teacherA1b, assign(U.teacherA1b, GROUP.A1b, T1))).resolves.toBeDefined();
    await expectDenied(as(db, U.teacherA1, assign(U.teacherA1, GROUP.A1, T3)), /published assessment/);
    await expectDenied(as(db, U.studentA1, assign(U.studentA1, GROUP.A1, T1)));
  });
});

describe('progress', () => {
  it('tracks opening and completion only for visible lessons; completion is sticky', async () => {
    const progress = await as(db, U.studentA1, async (tx) => {
      await tx.query('select public.track_lesson($1, false)', [L1]);
      await tx.query('select public.track_lesson($1, true)', [L1]);
      await tx.query('select public.track_lesson($1, false)', [L1]); // повторное открытие не отменяет завершение
      return rows<{ status: string }>(tx, 'select status from public.lesson_progress where lesson_id = $1', [L1]);
    });
    expect(progress).toEqual([{ status: 'completed' }]);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query('select public.track_lesson($1, true)', [L2])), /not available/);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query('select public.track_lesson($1, true)', [L4])), /not available/);
    await expectDenied(as(db, U.studentB, (tx) => tx.query('select public.track_lesson($1, true)', [L1])), /not available/);
    await expectDenied(
      as(db, U.studentA1, (tx) => tx.query(`insert into public.lesson_progress (organization_id, lesson_id, student_id, status, completed_at) values ($1, $2, $3, 'completed', now())`, [ORG.A, L3, U.studentA1])),
      /permission denied/,
    );
  });

  it('progress visibility follows the same rules as results', async () => {
    const view = (user: string) => as(db, user, (tx) => tx.query('select public.course_progress($1, $2)', [COURSE.A, U.studentA1]));
    for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.managerA1]) await expect(view(user), user).resolves.toBeDefined();
    for (const user of [U.studentA1b, U.teacherA2, U.teacherB, U.adminA1]) await expectDenied(view(user), /not available/);
  });
});

describe('full scenario: enrolment → lesson → test → review → progress', () => {
  it('works end to end and progress matches the stored rows', async () => {
    const result = await asMfa(db, U.adminA1, async (tx) => {
      const switchTo = (sub: string) => tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal: 'aal2' })]);
      // 1. Новый ученик получает роль и запись в группу (администратор филиала).
      await tx.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, 'student')`, [ORG.A, BRANCH.A1, U.outsider]);
      await tx.query(`insert into public.enrollments (organization_id, branch_id, group_id, student_id, status, created_by) values ($1, $2, $3, $4, 'active', $5)`, [
        ORG.A, BRANCH.A1, GROUP.A1b, U.outsider, U.adminA1,
      ]);
      // 2. Преподаватель группы назначает тест.
      await switchTo(U.teacherA1b);
      await tx.query(`insert into public.group_assessments (organization_id, branch_id, group_id, assessment_id, opens_at, assigned_by) values ($1, $2, $3, $4, now() - interval '1 minute', $5)`, [
        ORG.A, BRANCH.A1, GROUP.A1b, T1, U.teacherA1b,
      ]);
      // 3. Ученик проходит урок и тест.
      await switchTo(U.outsider);
      const before = (await tx.query<{ r: { lessonsTotal: number; lessonsCompleted: number; nextLessonId: string } }>('select public.course_progress($1) as r', [COURSE.A])).rows[0]!.r;
      await tx.query('select public.track_lesson($1, false)', [L1]);
      await tx.query('select public.track_lesson($1, true)', [L1]);
      const attempt = (await submit(tx, T1, ALL_CORRECT)).rows[0]!.id;
      const reviewed = (await tx.query<{ r: { score: string; answersRevealed: boolean } }>('select public.attempt_review($1) as r', [attempt])).rows[0]!.r;
      const after = (await tx.query<{ r: { lessonsTotal: number; lessonsCompleted: number; nextLessonId: string; lastLessonId: string; assessments: { bestScore: string; attempts: number }[] } }>(
        'select public.course_progress($1) as r',
        [COURSE.A],
      )).rows[0]!.r;
      const storedCompleted = await count(tx, `select 1 from public.lesson_progress where student_id = $1 and status = 'completed'`, [U.outsider]);
      // 4. Преподаватель видит результат ученика.
      await switchTo(U.teacherA1b);
      const teacherSees = await count(tx, 'select 1 from public.assessment_attempts where student_id = $1', [U.outsider]);
      return { before, reviewed, after, storedCompleted, teacherSees };
    });

    expect(result.before).toMatchObject({ lessonsTotal: 2, lessonsCompleted: 0, nextLessonId: L1 });
    expect(result.reviewed).toMatchObject({ score: '6.00', answersRevealed: true });
    expect(result.after).toMatchObject({ lessonsTotal: 2, lessonsCompleted: 1, nextLessonId: L3, lastLessonId: L1 });
    expect(result.after.lessonsCompleted).toBe(result.storedCompleted);
    expect(result.after.assessments).toEqual([expect.objectContaining({ bestScore: '6.00', attempts: 1 })]);
    expect(result.teacherSees).toBe(1);
  });
});

describe('course lists for the workspace', () => {
  it('my_editable_courses: course teachers and catalog managers only', async () => {
    const list = (u: string) => as(db, u, async (tx) => (await rows<{ id: string }>(tx, 'select id from public.my_editable_courses()')).map((r) => r.id));
    expect(await list(U.teacherA1)).toEqual([COURSE.A]);
    expect(await list(U.directorA)).toEqual([COURSE.A]);
    for (const u of [U.studentA1, U.adminA1, U.teacherB]) expect(await list(u), u).not.toContain(COURSE.A);
  });

  it('my_learning_courses: own enrolments and wards only', async () => {
    const list = (u: string) => as(db, u, async (tx) => rows<{ id: string; student_id: string }>(tx, 'select id, student_id from public.my_learning_courses()'));
    expect(await list(U.studentA1)).toEqual([{ id: COURSE.A, student_id: U.studentA1 }]);
    expect(await list(U.parentA1)).toEqual([{ id: COURSE.A, student_id: U.studentA1 }]);
    expect(await list(U.teacherA1)).toEqual([]);
    expect(await list(U.studentB)).toEqual([{ id: COURSE.B, student_id: U.studentB }]);
  });
});
