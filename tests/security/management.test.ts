import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

/**
 * Блок A: задачи директора и руководителей сотрудникам, объявления с подтверждением
 * ознакомления, панель показателей по филиалам (сверка с исходными данными).
 */
let db: PGlite;
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();
const PAST_S = 'e2000000-0000-4000-8000-000000000001'; // A1, вчера, отмечено
const PAST_U = 'e2000000-0000-4000-8000-000000000002'; // A1, вчера, не отмечено

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period, status) values
      ('${PAST_S}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', tstzrange(now() - interval '26 hours', now() - interval '25 hours'), 'done'),
      ('${PAST_U}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1b}', '${U.teacherA1b}', '${ROOM.A1x}', tstzrange(now() - interval '28 hours', now() - interval '27 hours'), 'scheduled');
    insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source, marked_by) values
      ('${ORG.A}', '${BRANCH.A1}', '${PAST_S}', '${U.studentA1}', 'present', 'teacher', '${U.teacherA1}');
  `);
}, 60_000);

const target = (profileId: string, branchId: string | null) => ({ profileId, branchId });
const create = (tx: Tx, targets: object[], title = 'Сдать отчёт за месяц', due: string | null = FUTURE) =>
  tx.query<{ batch: string }>(`select public.task_create($1, $2, $3, 'Подробности', 'high', $4) as batch`, [ORG.A, JSON.stringify(targets), title, due]);
const taskOf = async (batch: string, assignee: string) =>
  (await rows<{ id: string; status: string }>(db, 'select id, status from public.staff_tasks where batch_id = $1 and assignee_id = $2', [batch, assignee]))[0]!;
const transition = (tx: Tx, task: string, action: string, note: string | null = null) =>
  tx.query<{ s: string }>('select public.task_transition($1, $2, $3) as s', [task, action, note]);
const notes = (user: string, kind: string) => count(db, 'select 1 from public.notifications where recipient_id = $1 and kind = $2', [user, kind]);

describe('staff tasks: who can assign', () => {
  it('the director sends one task to administrators of several branches as separate tasks', async () => {
    const [r] = (await asMfa(db, U.directorA, (tx) => create(tx, [target(U.adminA1, BRANCH.A1), target(U.managerA2, BRANCH.A2)]), { commit: true })).rows;
    const tasks = await rows<{ assignee_id: string; branch_id: string; status: string }>(db, 'select assignee_id, branch_id, status from public.staff_tasks where batch_id = $1 order by branch_id', [r!.batch]);
    expect(tasks).toEqual([
      { assignee_id: U.adminA1, branch_id: BRANCH.A1, status: 'open' },
      { assignee_id: U.managerA2, branch_id: BRANCH.A2, status: 'open' },
    ]);
    expect(await notes(U.adminA1, 'task_assigned')).toBe(1);
    expect(await notes(U.managerA2, 'task_assigned')).toBe(1);
    expect(await count(db, `select 1 from public.staff_task_events e join public.staff_tasks t on t.id = e.task_id where t.batch_id = $1 and e.kind = 'created'`, [r!.batch])).toBe(2);
  });

  it('needs MFA, task.manage in that branch and a staff assignee of that branch', async () => {
    await expectDenied(as(db, U.directorA, (tx) => create(tx, [target(U.adminA1, BRANCH.A1)])), /mfa required/);
    await expectDenied(asMfa(db, U.managerA1, (tx) => create(tx, [target(U.managerA2, BRANCH.A2)])), /not allowed/);
    await expectDenied(asMfa(db, U.adminA1, (tx) => create(tx, [target(U.salesA1, BRANCH.A1)])), /not allowed/);
    await expectDenied(asMfa(db, U.teacherA1, (tx) => create(tx, [target(U.adminA1, BRANCH.A1)])), /not allowed/);
    await expectDenied(asMfa(db, U.directorB, (tx) => create(tx, [target(U.adminA1, BRANCH.A1)])), /not allowed/);
    for (const who of [U.studentA1, U.parentA1, U.directorA, U.teacherB, U.adminA1]) {
      // Ученик, родитель, сам автор, чужая школа, сотрудник другого филиала (adminA1 в A2) — нельзя.
      const branch = who === U.adminA1 ? BRANCH.A2 : BRANCH.A1;
      await expectDenied(asMfa(db, U.directorA, (tx) => create(tx, [target(who, branch)])), /assignee is not staff/);
    }
    await expectDenied(asMfa(db, U.directorA, (tx) => create(tx, [target(U.adminA1, BRANCH.A1)], 'x')), /title_check/);
    await expectDenied(asMfa(db, U.directorA, (tx) => create(tx, [target(U.adminA1, BRANCH.A1)], 'Задача', '2020-01-01T00:00:00Z')), /due date/);
    await expectDenied(asMfa(db, U.directorA, (tx) => create(tx, [target(U.adminA1, BRANCH.A1), target(U.adminA1, BRANCH.A1)])), /batch_assignee_key/);
    await expectDenied(asMfa(db, U.directorA, (tx) => create(tx, [])), /invalid targets/);
    // Менеджер филиала ставит задачи своим сотрудникам; бухгалтер без филиала — только директор (уровень школы).
    await asMfa(db, U.managerA1, (tx) => create(tx, [target(U.adminA1, BRANCH.A1), target(U.teacherA1, BRANCH.A1)]));
    await asMfa(db, U.directorA, (tx) => create(tx, [target(U.accountantA, null)]));
    await expectDenied(asMfa(db, U.managerA1, (tx) => create(tx, [target(U.accountantA, null)])), /not allowed/);
  });

  it('tables are read-only for users: changes go through the functions only', async () => {
    await expectDenied(asMfa(db, U.directorA, (tx) =>
      tx.query(`insert into public.staff_tasks (organization_id, branch_id, batch_id, title, assignee_id, created_by) values ($1, $2, gen_random_uuid(), 'Обход', $3, $4)`, [ORG.A, BRANCH.A1, U.adminA1, U.directorA])));
    await expectDenied(as(db, U.adminA1, (tx) => tx.query(`update public.staff_tasks set status = 'done'`)));
    await expectDenied(asService(db, (tx) => tx.query(`update public.staff_task_events set body = 'x'`)), /append-only/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.staff_task_events`)), /append-only/);
  });
});

describe('staff tasks: visibility and workflow', () => {
  let batch = '';
  let task = '';
  beforeAll(async () => {
    batch = (await asMfa(db, U.directorA, (tx) => create(tx, [target(U.adminA1, BRANCH.A1), target(U.managerA2, BRANCH.A2)], 'Проверить журналы'), { commit: true })).rows[0]!.batch;
    task = (await taskOf(batch, U.adminA1)).id;
  });

  it('assignees see their own tasks, managers see their scope, others nothing', async () => {
    const visible = (user: string) => as(db, user, (tx) => count(tx, 'select 1 from public.staff_tasks where batch_id = $1', [batch]));
    expect(await visible(U.directorA)).toBe(2);
    expect(await visible(U.managerA1)).toBe(1); // задача филиала A1
    expect(await visible(U.adminA1)).toBe(1);
    expect(await visible(U.managerA2)).toBe(1); // своя
    for (const u of [U.teacherA1, U.salesA1, U.studentA1, U.directorB, U.adminA1]) {
      if (u !== U.adminA1) expect(await visible(u), u).toBe(0);
    }
    expect(await as(db, U.adminA1, (tx) => count(tx, 'select 1 from public.staff_task_events where task_id = $1', [task]))).toBe(1);
    expect(await as(db, U.teacherA1, (tx) => count(tx, 'select 1 from public.staff_task_events where task_id = $1', [task]))).toBe(0);
  });

  it('assignee starts and submits a report; the author returns it, then accepts', async () => {
    await expectDenied(as(db, U.salesA1, (tx) => transition(tx, task, 'start')), /not available/);
    expect((await as(db, U.adminA1, (tx) => transition(tx, task, 'start'), { commit: true })).rows[0]!.s).toBe('in_progress');
    await expectDenied(as(db, U.adminA1, (tx) => transition(tx, task, 'start')), /invalid transition/);
    await expectDenied(as(db, U.adminA1, (tx) => transition(tx, task, 'submit', '  ')), /report required/);
    await expectDenied(asMfa(db, U.directorA, (tx) => transition(tx, task, 'accept')), /invalid transition/); // ещё не сдана
    expect((await as(db, U.adminA1, (tx) => transition(tx, task, 'submit', 'Журналы проверены, 2 замечания'), { commit: true })).rows[0]!.s).toBe('submitted');
    expect(await notes(U.directorA, 'task_submitted')).toBeGreaterThanOrEqual(1);

    // Менеджер филиала видит задачу, но принять чужую (директорскую) задачу не может; без MFA — тоже нет.
    await expectDenied(asMfa(db, U.managerA1, (tx) => transition(tx, task, 'accept')), /not available/);
    await expectDenied(as(db, U.directorA, (tx) => transition(tx, task, 'accept')), /not available/);
    await expectDenied(asMfa(db, U.directorA, (tx) => transition(tx, task, 'return')), /comment required/);
    expect((await asMfa(db, U.directorA, (tx) => transition(tx, task, 'return', 'Приложите список замечаний'), { commit: true })).rows[0]!.s).toBe('in_progress');
    expect(await notes(U.adminA1, 'task_returned')).toBe(1);

    await as(db, U.adminA1, (tx) => transition(tx, task, 'submit', 'Список: ...'), { commit: true });
    expect((await asMfa(db, U.directorA, (tx) => transition(tx, task, 'accept'), { commit: true })).rows[0]!.s).toBe('done');
    await expectDenied(asMfa(db, U.directorA, (tx) => transition(tx, task, 'cancel', 'поздно')), /invalid transition/);
    await expectDenied(as(db, U.adminA1, (tx) => transition(tx, task, 'submit', 'ещё')), /invalid transition/);

    const history = (await rows<{ kind: string }>(db, 'select kind from public.staff_task_events where task_id = $1 order by created_at, kind', [task])).map((r) => r.kind);
    expect(history).toEqual(['created', 'started', 'submitted', 'returned', 'submitted', 'accepted']);
    const row = (await rows<{ completed_at: string | null; result_note: string }>(db, 'select completed_at, result_note from public.staff_tasks where id = $1', [task]))[0]!;
    expect(row.completed_at).not.toBeNull();
    expect(row.result_note).toBe('Список: ...');
  });

  it('a manager cannot accept or cancel a task assigned to themselves', async () => {
    const own = await taskOf(batch, U.managerA2);
    await as(db, U.managerA2, (tx) => transition(tx, own.id, 'submit', 'Готово'), { commit: true });
    await expectDenied(asMfa(db, U.managerA2, (tx) => transition(tx, own.id, 'accept')), /not available/);
    await expectDenied(asMfa(db, U.managerA2, (tx) => transition(tx, own.id, 'cancel', 'не нужно')), /not available/);
    await expectDenied(asMfa(db, U.directorA, (tx) => transition(tx, own.id, 'cancel')), /reason required/);
    expect((await asMfa(db, U.directorA, (tx) => transition(tx, own.id, 'cancel', 'Отменено директором'), { commit: true })).rows[0]!.s).toBe('cancelled');
    expect(await notes(U.managerA2, 'task_cancelled')).toBe(1);
    await expectDenied(asMfa(db, U.directorA, (tx) => transition(tx, own.id, 'bogus')), /unknown action|invalid transition/);
  });

  it('even after promotion to the school level, the assignee cannot accept their own task', async () => {
    const b = (await asMfa(db, U.directorA, (tx) => create(tx, [target(U.managerA1, BRANCH.A1)], 'Своя задача'), { commit: true })).rows[0]!.batch;
    const own = await taskOf(b, U.managerA1);
    await as(db, U.managerA1, (tx) => transition(tx, own.id, 'submit', 'Сделано'), { commit: true });
    await db.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, null, $2, 'org_director')`, [ORG.A, U.managerA1]);
    try {
      await expectDenied(asMfa(db, U.managerA1, (tx) => transition(tx, own.id, 'accept')), /not available/);
    } finally {
      await db.query(`delete from public.memberships where organization_id = $1 and profile_id = $2 and role = 'org_director'`, [ORG.A, U.managerA1]);
    }
  });

  it('comments by the assignee or a manager notify the other side', async () => {
    await as(db, U.adminA1, (tx) => tx.query(`select public.task_comment($1, 'Вопрос по срокам')`, [task]), { commit: true });
    expect(await notes(U.directorA, 'task_comment')).toBe(1);
    await expectDenied(as(db, U.teacherA1, (tx) => tx.query(`select public.task_comment($1, 'Чужая')`, [task])), /not available/);
    await expectDenied(as(db, U.managerA1, (tx) => tx.query(`select public.task_comment($1, 'Без MFA')`, [task])), /not available/);
    await expectDenied(as(db, U.adminA1, (tx) => tx.query(`select public.task_comment($1, '   ')`, [task])), /comment length/);
  });

  it('overdue tasks remind the assignee and the author once', async () => {
    const b = (await asMfa(db, U.managerA1, (tx) => create(tx, [target(U.salesA1, BRANCH.A1)], 'Обзвонить заявки', new Date(Date.now() + 3_600_000).toISOString()), { commit: true })).rows[0]!.batch;
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const run = () => asService(db, (tx) => tx.query<{ r: { overdueTasks: number } }>('select public.generate_task_reminders($1) as r', [later]), { commit: true });
    expect((await run()).rows[0]!.r.overdueTasks).toBeGreaterThanOrEqual(1);
    await run();
    const key = `task-overdue:${(await taskOf(b, U.salesA1)).id}`;
    expect(await count(db, 'select 1 from public.notifications where dedupe_key = $1', [key])).toBe(2); // исполнитель + автор, без дублей
    // Принятые и отменённые задачи не напоминают о себе.
    expect(await count(db, `select 1 from public.notifications where dedupe_key = $1`, [`task-overdue:${task}`])).toBe(0);
    await expectDenied(asMfa(db, U.directorA, (tx) => tx.query('select public.generate_task_reminders()')), /permission denied/);
  });
});

describe('announcements', () => {
  const publish = (tx: Tx, branch: string | null, audience: string[], ack = false, title = 'Собрание в пятницу') =>
    tx.query<{ id: string }>('select public.announcement_publish($1, $2, $3, $4, $5, $6) as id', [ORG.A, branch, title, 'Текст объявления', audience, ack]);
  let branchNote = '';
  let staffNote = '';

  it('the director addresses one branch or the whole school; recipients are fixed at publication', async () => {
    branchNote = (await asMfa(db, U.directorA, (tx) => publish(tx, BRANCH.A1, ['teacher', 'student', 'parent'], true), { commit: true })).rows[0]!.id;
    const rcpt = (await rows<{ profile_id: string }>(db, 'select profile_id from public.announcement_recipients where announcement_id = $1 order by 1', [branchNote])).map((r) => r.profile_id);
    expect(rcpt).toEqual([U.teacherA1, U.teacherA1b, U.studentA1, U.studentA1b, U.parentA1].sort());
    expect((await rows<{ n: number }>(db, 'select recipient_count n from public.announcements where id = $1', [branchNote]))[0]!.n).toBe(5);
    expect(await notes(U.studentA1, 'announcement_ack')).toBe(1);

    staffNote = (await asMfa(db, U.directorA, (tx) => publish(tx, null, ['branch_manager', 'admin']), { commit: true })).rows[0]!.id;
    const staff = (await rows<{ profile_id: string }>(db, 'select profile_id from public.announcement_recipients where announcement_id = $1 order by 1', [staffNote])).map((r) => r.profile_id);
    expect(staff).toEqual([U.managerA1, U.adminA1, U.managerA2].sort());
    expect(await notes(U.adminA1, 'announcement')).toBe(1);
  });

  it('branch staff publish only in their branch; others cannot publish', async () => {
    await asMfa(db, U.adminA1, (tx) => publish(tx, BRANCH.A1, ['student']));
    await expectDenied(asMfa(db, U.adminA1, (tx) => publish(tx, BRANCH.A2, ['student'])), /not allowed/);
    await expectDenied(asMfa(db, U.adminA1, (tx) => publish(tx, null, ['student'])), /not allowed/);
    await expectDenied(as(db, U.directorA, (tx) => publish(tx, BRANCH.A1, ['student'])), /not allowed/);
    for (const u of [U.teacherA1, U.salesA1, U.accountantA, U.studentA1, U.directorB]) {
      await expectDenied(asMfa(db, u, (tx) => publish(tx, BRANCH.A1, ['student'])), /not allowed/);
    }
    await expectDenied(asMfa(db, U.directorA, (tx) => publish(tx, BRANCH.A2, ['accountant'])), /no recipients/);
    await expectDenied(asMfa(db, U.directorA, (tx) => publish(tx, BRANCH.A1, ['student', 'hacker'])), /audience_check/);
    await expectDenied(asMfa(db, U.directorA, (tx) => publish(tx, BRANCH.A1, [])), /audience_check/);
  });

  it('recipients see their announcements; receipts are private except for publishers', async () => {
    const sees = (u: string, id: string) => as(db, u, (tx) => count(tx, 'select 1 from public.announcements where id = $1', [id]));
    expect(await sees(U.studentA1, branchNote)).toBe(1);
    expect(await sees(U.studentA2, branchNote)).toBe(0);
    expect(await sees(U.managerA2, branchNote)).toBe(0);
    expect(await sees(U.managerA1, branchNote)).toBe(1); // публикует в своём филиале
    expect(await sees(U.directorB, branchNote)).toBe(0);
    expect(await as(db, U.studentA1, (tx) => count(tx, 'select 1 from public.announcement_recipients where announcement_id = $1', [branchNote]))).toBe(1);
    expect(await as(db, U.directorA, (tx) => count(tx, 'select 1 from public.announcement_recipients where announcement_id = $1', [branchNote]))).toBe(5);
  });

  it('read and acknowledge: only own receipt, acknowledgement only when requested', async () => {
    await as(db, U.studentA1, (tx) => tx.query('select public.announcement_read($1, true)', [branchNote]), { commit: true });
    await as(db, U.parentA1, (tx) => tx.query('select public.announcement_read($1)', [branchNote]), { commit: true });
    const r = await rows<{ profile_id: string; read: boolean; ack: boolean }>(db,
      'select profile_id, read_at is not null as read, acknowledged_at is not null as ack from public.announcement_recipients where announcement_id = $1 and profile_id in ($2, $3) order by 1',
      [branchNote, U.studentA1, U.parentA1]);
    expect(r).toEqual([{ profile_id: U.studentA1, read: true, ack: true }, { profile_id: U.parentA1, read: true, ack: false }].sort((a, b) => a.profile_id.localeCompare(b.profile_id)));
    await expectDenied(as(db, U.studentA2, (tx) => tx.query('select public.announcement_read($1)', [branchNote])), /not available/);
    await expectDenied(as(db, U.adminA1, (tx) => tx.query('select public.announcement_read($1, true)', [staffNote])), /not requested/);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`update public.announcement_recipients set acknowledged_at = now()`)));
  });

  it('read statistics are visible to publishers in scope only', async () => {
    const stats = (u: string) => as(db, u, async (tx) => (await tx.query<{ s: Record<string, { recipients: number; read: number; acknowledged: number }> }>('select public.announcement_stats($1) as s', [[branchNote, staffNote]])).rows[0]!.s);
    expect((await stats(U.directorA))[branchNote]).toEqual({ recipients: 5, read: 2, acknowledged: 1 });
    expect(Object.keys(await stats(U.managerA1))).toEqual([branchNote]); // объявление всей школы — уровень директора
    expect(await stats(U.studentA1)).toEqual({});
    expect(await stats(U.managerA2)).toEqual({});
  });

  it('a published announcement is immutable and is archived, not deleted', async () => {
    await expectDenied(asService(db, (tx) => tx.query(`update public.announcements set body = 'Другой текст' where id = $1`, [branchNote])), /immutable/);
    await expectDenied(asService(db, (tx) => tx.query(`delete from public.announcements where id = $1`, [branchNote])), /archived, not deleted/);
    await expectDenied(asMfa(db, U.managerA1, (tx) => tx.query('select public.announcement_archive($1)', [branchNote])), /not available/);
    await asMfa(db, U.directorA, (tx) => tx.query('select public.announcement_archive($1)', [branchNote]), { commit: true });
    expect((await rows<{ status: string }>(db, 'select status from public.announcements where id = $1', [branchNote]))[0]!.status).toBe('archived');
  });
});

describe('branch dashboard', () => {
  type Row = Record<string, unknown> & { branchId: string; branch: string; finance: Record<string, Record<string, string>> | null };
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const dash = (u: string, org: string = ORG.A, f = from, t = today) =>
    as(db, u, async (tx) => ((await tx.query<{ d: Row[] }>('select public.branch_dashboard($1, $2, $3) as d', [org, f, t])).rows[0]!.d));
  const scalar = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: number | string }>(db, sql, params))[0]!.n);

  it('shows each branch only to those with dashboard.read in it; finance only with finance.read', async () => {
    expect((await dash(U.directorA)).map((r) => r.branchId).sort()).toEqual([BRANCH.A1, BRANCH.A2].sort());
    expect((await dash(U.managerA1)).map((r) => r.branchId)).toEqual([BRANCH.A1]);
    const admin = await dash(U.adminA1);
    expect(admin.map((r) => r.branchId)).toEqual([BRANCH.A1]);
    expect(admin[0]!.finance).toBeNull();
    expect((await dash(U.managerA1))[0]!.finance).not.toBeNull();
    for (const u of [U.teacherA1, U.accountantA, U.salesA1, U.studentA1, U.parentA1, U.directorB]) expect(await dash(u), u).toEqual([]);
    await expectDenied(dash(U.directorA, ORG.A, today, from), /invalid period/);
  });

  it('numbers match the source data (A1)', async () => {
    const a1 = (await dash(U.directorA)).find((r) => r.branchId === BRANCH.A1)!;
    expect(a1.students).toBe(await scalar(`select count(distinct student_id) n from public.enrollments where branch_id = $1 and status = 'active'`, [BRANCH.A1]));
    expect(a1.groups).toBe(await scalar(`select count(*) n from public.groups where branch_id = $1 and status in ('planned', 'active')`, [BRANCH.A1]));
    expect(a1.sessions).toEqual({ planned: 2, done: 1, cancelled: 0, unmarked: 1 }); // PAST_S отмечено, PAST_U — нет
    expect(a1.attendance).toEqual({ marked: 1, present: 1 });
    expect(a1.homework).toEqual({
      waiting: await scalar(`select count(*) n from public.assignment_submissions where branch_id = $1 and status = 'submitted'`, [BRANCH.A1]),
      overdue: await scalar(`select count(*) n from public.assignment_submissions where branch_id = $1 and status = 'submitted' and submitted_at < now() - interval '72 hours'`, [BRANCH.A1]),
    });
    expect(a1.tasks).toEqual({
      open: await scalar(`select count(*) n from public.staff_tasks where branch_id = $1 and status in ('open', 'in_progress', 'submitted')`, [BRANCH.A1]),
      overdue: await scalar(`select count(*) n from public.staff_tasks where branch_id = $1 and status in ('open', 'in_progress') and due_at < now()`, [BRANCH.A1]),
      done: 1,
    });
    const ann = a1.announcements as { published: number; ackRequested: number; acknowledged: number };
    expect(ann).toEqual({ published: await scalar(`select count(*) n from public.announcements where branch_id = $1`, [BRANCH.A1]), ackRequested: 5, acknowledged: 1 });
    // Финансы совпадают с finance_report (этап 9) за тот же период.
    const report = await asMfa(db, U.directorA, async (tx) =>
      (await tx.query<{ r: { branchId: string; currency: string; received: string; outstanding: string }[] }>('select public.finance_report($1, $2, $3) as r', [ORG.A, from, today])).rows[0]!.r);
    const kgs = report.find((x) => x.branchId === BRANCH.A1 && x.currency === 'KGS')!;
    expect(a1.finance!.KGS!.received).toBe(kgs.received);
    expect(a1.finance!.KGS!.outstanding).toBe(kgs.outstanding);
  });
});
