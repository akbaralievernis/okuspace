import type { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, GROUP, ORG, ROOM, U, createSeededDb } from '../db/fixtures';
import { as, asService, count, rows, type Tx } from '../db/harness';

/**
 * Этап 10: политика (выключено без юридических условий), приём только чисел от устройств
 * с секретом, сопоставление с расписанием → предупреждения для проверки человеком,
 * изоляция филиалов, журнал просмотра, срок хранения.
 */
let db: PGlite;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D_OCC = id(1); // счётчик людей, A1, аудитория 102
const D_ENTRY = id(2); // вход/выход, A1, аудитория 102
const D_A2 = id(3); // счётчик, A2
const D_OFF = id(4); // отключён
const S_EMPTY = id(11); // GROUP.A1, 3–2 часа назад — никого
const S_FULL = id(12); // GROUP.A1b, 5–4 часа назад — 6 человек

beforeAll(async () => {
  db = await createSeededDb();
  await db.exec(`
    insert into public.monitoring_policies (organization_id, enabled, purpose, legal_basis, notice_text, notice_published_at, legal_reviewed_at, legal_reviewer, updated_by)
    values ('${ORG.A}', true, 'Контроль загрузки аудиторий и расхождений с расписанием', 'Согласие и уведомление по закону КР о персональных данных',
            'В аудиториях работают счётчики людей: изображения не сохраняются, личности не определяются.', now(), now(), 'Юрист школы', '${U.directorA}');
    insert into public.camera_devices (id, organization_id, branch_id, classroom_id, name, kind, status, token_sha256, created_by) values
      ('${D_OCC}', '${ORG.A}', '${BRANCH.A1}', '${ROOM.A1x}', 'Счётчик 102', 'occupancy_counter', 'active', '${sha('tok-occ')}', '${U.directorA}'),
      ('${D_ENTRY}', '${ORG.A}', '${BRANCH.A1}', '${ROOM.A1x}', 'Вход 102', 'entrance_counter', 'active', '${sha('tok-entry')}', '${U.directorA}'),
      ('${D_A2}', '${ORG.A}', '${BRANCH.A2}', '${ROOM.A2}', 'Счётчик 201', 'occupancy_counter', 'active', '${sha('tok-a2')}', '${U.directorA}'),
      ('${D_OFF}', '${ORG.A}', '${BRANCH.A1}', '${ROOM.A1x}', 'Старый', 'occupancy_counter', 'disabled', '${sha('tok-off')}', '${U.directorA}');
    insert into public.lesson_sessions (id, organization_id, branch_id, group_id, teacher_id, classroom_id, period) values
      ('${S_EMPTY}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1x}', tstzrange(now() - interval '3 hours', now() - interval '2 hours')),
      ('${S_FULL}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1b}', '${U.teacherA1b}', '${ROOM.A1x}', tstzrange(now() - interval '5 hours', now() - interval '4 hours'));
  `);
}, 60_000);

const switchTo = (tx: Tx, sub: string | null, aal: 'aal1' | 'aal2' = 'aal2') =>
  sub === null
    ? tx.exec('set local role service_role')
    : tx.exec('set local role authenticated').then(() => tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal })]));
const ingest = (tx: Tx, device: string, token: string, kind: string, at: string, n: number | null = null) =>
  tx.query<{ r: { outcome: string; sessionId?: string } }>(`select public.ingest_monitoring($1, $2, $3, $4, ${at}) as r`, [device, sha(token), kind, n]).then((x) => x.rows[0]!.r);
const attempt = async (tx: Tx, sql: string, params: unknown[] = []) => {
  await tx.exec('savepoint a');
  try {
    const r = await tx.query(sql, params);
    return `ok:${r.affectedRows ?? 0}`;
  } catch (e) {
    await tx.exec('rollback to savepoint a');
    return (e as Error).message;
  }
};
/** Данные двух прошедших занятий: пустое (0 человек) и полное (6 человек), один подтверждённо присутствующий. */
const seedCounts = async (tx: Tx) => {
  await switchTo(tx, null);
  for (const m of [170, 160, 140]) await ingest(tx, D_OCC, 'tok-occ', 'occupancy', `now() - interval '${m} minutes'`, 0);
  for (const [m, n] of [[290, 5], [280, 6], [260, 6]] as const) await ingest(tx, D_OCC, 'tok-occ', 'occupancy', `now() - interval '${m} minutes'`, n);
  await tx.query(`insert into public.attendance_records (organization_id, branch_id, session_id, student_id, status, source, marked_by) values ($1, $2, $3, $4, 'present', 'teacher', $5)`, [
    ORG.A, BRANCH.A1, S_FULL, U.studentA1b, U.teacherA1b,
  ]);
};

describe('monitoring policy: off without legal conditions', () => {
  it('cannot be enabled without purpose, legal basis, published notice and legal review', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      await switchTo(tx, U.directorA);
      return attempt(tx, `update public.monitoring_policies set legal_reviewed_at = null, updated_by = $2 where organization_id = $1`, [ORG.A, U.directorA]);
    });
    expect(r).toMatch(/monitoring_policies_enable_check/);
  });

  it('only the director with MFA changes it; every member can read the notice', async () => {
    const r = await as(db, U.directorA, async (tx) => {
      const out: Record<string, string> = {};
      for (const [user, aal] of [[U.directorA, 'aal1'], [U.managerA1, 'aal2'], [U.adminA1, 'aal2']] as const) {
        await switchTo(tx, user, aal);
        out[`${user}:${aal}`] = await attempt(tx, `update public.monitoring_policies set data_retention_days = 10, updated_by = $2 where organization_id = $1`, [ORG.A, user]);
      }
      await switchTo(tx, U.studentA1, 'aal1');
      out.notice = String(await count(tx, 'select 1 from public.monitoring_policies where notice_text is not null'));
      return out;
    });
    expect(Object.values(r).slice(0, 3)).toEqual(['ok:0', 'ok:0', 'ok:0']);
    expect(r.notice).toBe('1');
  });
});

describe('device ingestion: numbers only, from authenticated devices', () => {
  it('needs the device secret; links the count to the lesson in that room; repeats are ignored', async () => {
    const r = await asService(db, async (tx) => ({
      wrong: await ingest(tx, D_OCC, 'guess', 'occupancy', `now() - interval '150 minutes'`, 3),
      unknown: await ingest(tx, id(99), 'tok-occ', 'occupancy', `now() - interval '150 minutes'`, 3),
      ok: await ingest(tx, D_OCC, 'tok-occ', 'occupancy', `now() - interval '150 minutes'`, 3),
      repeat: await ingest(tx, D_OCC, 'tok-occ', 'occupancy', `now() - interval '150 minutes'`, 3),
      entry: await ingest(tx, D_ENTRY, 'tok-entry', 'in', `now() - interval '175 minutes'`),
      wrongKind: await ingest(tx, D_ENTRY, 'tok-entry', 'occupancy', `now()`, 3),
      disabled: await ingest(tx, D_OFF, 'tok-off', 'occupancy', `now()`, 3),
      future: await ingest(tx, D_OCC, 'tok-occ', 'occupancy', `now() + interval '1 hour'`, 3),
      snapshots: await count(tx, 'select 1 from public.occupancy_snapshots'),
      crossings: await count(tx, 'select 1 from public.zone_crossings'),
    }));
    expect(r.wrong).toEqual({ outcome: 'unauthorized' });
    expect(r.unknown).toEqual({ outcome: 'unauthorized' });
    expect(r.ok).toEqual({ outcome: 'recorded', sessionId: S_EMPTY });
    expect(r.repeat).toEqual({ outcome: 'duplicate', sessionId: S_EMPTY });
    expect(r.entry).toMatchObject({ outcome: 'recorded' });
    expect([r.wrongKind.outcome, r.disabled.outcome, r.future.outcome]).toEqual(['rejected', 'disabled', 'rejected']);
    expect([r.snapshots, r.crossings]).toEqual([1, 1]);
  });

  it('when the school turns monitoring off, nothing is stored', async () => {
    const r = await asService(db, async (tx) => {
      await tx.query(`update public.monitoring_policies set enabled = false where organization_id = $1`, [ORG.A]);
      return { res: await ingest(tx, D_OCC, 'tok-occ', 'occupancy', `now()`, 2), stored: await count(tx, 'select 1 from public.occupancy_snapshots') };
    });
    expect(r).toEqual({ res: { outcome: 'disabled' }, stored: 0 });
  });

  it('users cannot call ingestion, read raw data directly or see device secrets', async () => {
    for (const sql of [
      `select public.ingest_monitoring('${D_OCC}', '${sha('tok-occ')}', 'occupancy', 1, now())`,
      'select * from public.occupancy_snapshots',
      'select * from public.zone_crossings',
      'select token_sha256 from public.camera_devices',
    ]) {
      await expectDenied(as(db, U.directorA, (tx) => tx.query(sql), { aal: 'aal2' }), /permission denied/);
    }
  });
});

describe('matching with the schedule → alerts for human review', () => {
  it('flags an empty lesson and a count mismatch once, notifies responsible staff, never changes attendance', async () => {
    const r = await asService(db, async (tx) => {
      await seedCounts(tx);
      const before = await count(tx, 'select 1 from public.attendance_records');
      const created = (await tx.query<{ n: number }>('select public.monitoring_check($1) as n', [ORG.A])).rows[0]!.n;
      const again = (await tx.query<{ n: number }>('select public.monitoring_check($1) as n', [ORG.A])).rows[0]!.n;
      const alerts = await rows<{ session_id: string; kind: string; details: Record<string, number> }>(tx, 'select session_id, kind, details from public.monitoring_alerts order by kind');
      const notified = (await rows<{ recipient_id: string }>(tx, `select distinct recipient_id from public.notifications where kind = 'monitoring_alert'`)).map((x) => x.recipient_id).sort();
      return { created, again, alerts, notified, attendanceUnchanged: before === (await count(tx, 'select 1 from public.attendance_records')) };
    });
    expect(r.created).toBe(2);
    expect(r.again).toBe(0);
    expect(r.alerts).toEqual([
      { session_id: S_FULL, kind: 'count_mismatch', details: { maxCount: 6, snapshots: 3, enrolled: 1, marked: 1 } },
      { session_id: S_EMPTY, kind: 'group_absent', details: { maxCount: 0, snapshots: 3, enrolled: 1, marked: 0 } },
    ]);
    expect(r.notified).toEqual([U.directorA, U.managerA1, U.adminA1].sort());
    expect(r.attendanceUnchanged).toBe(true);
  });

  it('a reviewer resolves an alert once, signed and with a note; facts stay; history is kept', async () => {
    const r = await asService(db, async (tx) => {
      await seedCounts(tx);
      await tx.query('select public.monitoring_check($1)', [ORG.A]);
      const alert = (await rows<{ id: string }>(tx, `select id from public.monitoring_alerts where kind = 'group_absent'`))[0]!.id;
      await switchTo(tx, U.adminA1);
      const forged = await attempt(tx, `update public.monitoring_alerts set status = 'confirmed', resolution_note = 'x x x', resolved_by = $2, resolved_at = now() where id = $1`, [alert, U.managerA1]);
      const facts = await attempt(tx, `update public.monitoring_alerts set details = '{}' where id = $1`, [alert]);
      const ok = await attempt(tx, `update public.monitoring_alerts set status = 'confirmed', resolution_note = 'Группа была на экскурсии, урок перенесён', resolved_by = $2, resolved_at = now() where id = $1`, [alert, U.adminA1]);
      const again = await attempt(tx, `update public.monitoring_alerts set status = 'dismissed', resolution_note = 'передумал', resolved_by = $2, resolved_at = now() where id = $1`, [alert, U.adminA1]);
      await switchTo(tx, null);
      const deleted = await attempt(tx, 'delete from public.monitoring_alerts where id = $1', [alert]);
      return { forged, facts, ok, again, deleted, audit: await count(tx, `select 1 from public.audit_logs where entity = 'monitoring_alerts' and entity_id = $1`, [alert]) };
    });
    expect(r.forged).toMatch(/signed by the reviewer|row-level security/);
    expect(r.facts).toMatch(/permission denied|immutable/);
    expect(r.ok).toBe('ok:1');
    expect(r.again).toMatch(/already resolved/);
    expect(r.deleted).toMatch(/append-only/);
    expect(r.audit).toBe(2);
  });

  it('a wrong attendance mark is corrected through the attendance journal, with history', async () => {
    const history = await asService(db, async (tx) => {
      await seedCounts(tx);
      await switchTo(tx, U.adminA1);
      // Администратор с MFA исправляет уже поставленную отметку — только с причиной (этап 6).
      await tx.query(`select public.mark_attendance($1, $2, $3)`, [S_FULL, JSON.stringify([{ studentId: U.studentA1b, status: 'absent', absenceReason: 'other' }]), 'Сверка с журналом группы']);
      return rows(tx, 'select status, reason from public.attendance_record_history where session_id = $1 order by id', [S_FULL]);
    });
    expect(history).toEqual([
      { status: 'present', reason: null },
      { status: 'absent', reason: 'Сверка с журналом группы' },
    ]);
  });
});

describe('branch isolation and access log', () => {
  it('other branches, teachers and other schools see no devices, alerts or room data', async () => {
    const r = await asService(db, async (tx) => {
      await seedCounts(tx);
      await tx.query('select public.monitoring_check($1)', [ORG.A]);
      const out: Record<string, string> = {};
      for (const user of [U.adminA1, U.managerA2, U.teacherA1, U.studentA1, U.directorB]) {
        await switchTo(tx, user);
        out[user] = `${await count(tx, 'select id from public.camera_devices where branch_id = $1', [BRANCH.A1])}/${await count(tx, 'select 1 from public.monitoring_alerts')}/${await attempt(tx, `select public.monitoring_room_timeline($1, now() - interval '1 day', now())`, [ROOM.A1x])}`;
      }
      return out;
    });
    expect(r[U.adminA1]).toBe('3/2/ok:0'); // SELECT выполнен (affectedRows для SELECT = 0)
    for (const u of [U.managerA2, U.teacherA1, U.studentA1, U.directorB]) expect(r[u], u).toMatch(/^0\/0\/not allowed$/);
  });

  it('every view of room data is written to the access log, readable by managers only', async () => {
    const r = await asService(db, async (tx) => {
      await switchTo(tx, U.adminA1);
      await tx.query(`select public.monitoring_room_timeline($1, now() - interval '1 day', now())`, [ROOM.A1x]);
      await tx.query(`select public.room_utilization($1, now() - interval '1 day', now())`, [ORG.A]);
      const adminSees = await count(tx, 'select 1 from public.monitoring_access_log');
      await switchTo(tx, U.directorA);
      const log = await rows(tx, 'select actor_id, action from public.monitoring_access_log order by id');
      // Менеджер филиала видит записи своего филиала; записи уровня школы — только директор.
      await switchTo(tx, U.managerA1);
      const branchLog = await rows(tx, 'select action from public.monitoring_access_log order by id');
      await switchTo(tx, U.managerA2);
      const otherBranch = await count(tx, 'select 1 from public.monitoring_access_log');
      await switchTo(tx, null);
      const edit = await attempt(tx, 'delete from public.monitoring_access_log');
      return { adminSees, log, branchLog, otherBranch, edit };
    });
    expect(r.adminSees).toBe(0);
    expect(r.log).toEqual([
      { actor_id: U.adminA1, action: 'view_room' },
      { actor_id: U.adminA1, action: 'view_utilization' },
    ]);
    expect(r.branchLog).toEqual([{ action: 'view_room' }]);
    expect(r.otherBranch).toBe(0);
    expect(r.edit).toMatch(/append-only/);
  });

  it('devices: managers of the branch with MFA add them; the audit log never contains the secret', async () => {
    const r = await as(db, U.managerA1, async (tx) => {
      await switchTo(tx, U.managerA1);
      const own = await attempt(tx, `insert into public.camera_devices (organization_id, branch_id, classroom_id, name, kind, token_sha256, created_by) values ($1, $2, $3, 'Новый', 'occupancy_counter', $4, $5)`, [ORG.A, BRANCH.A1, ROOM.A1, sha('new'), U.managerA1]);
      const other = await attempt(tx, `insert into public.camera_devices (organization_id, branch_id, classroom_id, name, kind, token_sha256, created_by) values ($1, $2, $3, 'Чужой', 'occupancy_counter', $4, $5)`, [ORG.A, BRANCH.A2, ROOM.A2, sha('x'), U.managerA1]);
      await switchTo(tx, U.adminA1);
      const admin = await attempt(tx, `update public.camera_devices set status = 'disabled' where id = $1`, [D_OCC]);
      await switchTo(tx, null);
      const audit = JSON.stringify(await rows(tx, `select diff from public.audit_logs where entity = 'camera_devices'`));
      return { own, other, admin, audit };
    });
    expect(r.own).toBe('ok:1');
    expect(r.other).toMatch(/row-level security/);
    expect(r.admin).toBe('ok:0');
    expect(r.audit).not.toContain(sha('new'));
  });
});

describe('retention and deletion', () => {
  it('the retention job removes old numbers and old resolved alerts; nothing else can delete them', async () => {
    const r = await asService(db, async (tx) => {
      await tx.query(`insert into public.occupancy_snapshots (organization_id, branch_id, classroom_id, device_id, observed_at, people_count) values ($1, $2, $3, $4, now() - interval '40 days', 4), ($1, $2, $3, $4, now() - interval '1 day', 5)`, [ORG.A, BRANCH.A1, ROOM.A1x, D_OCC]);
      await tx.query(`insert into public.zone_crossings (organization_id, branch_id, classroom_id, device_id, direction, crossed_at) values ($1, $2, $3, $4, 'in', now() - interval '40 days')`, [ORG.A, BRANCH.A1, ROOM.A1x, D_ENTRY]);
      await tx.query(`insert into public.monitoring_alerts (organization_id, branch_id, classroom_id, session_id, kind, details, status, resolution_note, resolved_by, resolved_at) values
        ($1, $2, $3, $4, 'group_absent', '{}', 'dismissed', 'старое', $5, now() - interval '200 days'),
        ($1, $2, $3, $6, 'group_absent', '{}', 'open', null, null, null)`, [ORG.A, BRANCH.A1, ROOM.A1x, S_EMPTY, U.adminA1, S_FULL]);
      const direct = await attempt(tx, 'delete from public.occupancy_snapshots');
      const purged = (await tx.query<{ r: object }>('select public.monitoring_purge() as r')).rows[0]!.r;
      return {
        direct,
        purged,
        left: { snapshots: await count(tx, 'select 1 from public.occupancy_snapshots'), crossings: await count(tx, 'select 1 from public.zone_crossings'), alerts: await count(tx, 'select 1 from public.monitoring_alerts') },
      };
    });
    expect(r.direct).toMatch(/retention job/);
    expect(r.purged).toEqual({ snapshots: 1, crossings: 1, alerts: 1 });
    expect(r.left).toEqual({ snapshots: 1, crossings: 0, alerts: 1 });
    await expectDenied(as(db, U.directorA, (tx) => tx.query('select public.monitoring_purge()'), { aal: 'aal2' }), /permission denied/);
  });
});

describe('room utilisation report', () => {
  it('reports scheduled and observed hours per room within the caller scope', async () => {
    const r = await asService(db, async (tx) => {
      await seedCounts(tx);
      await switchTo(tx, U.managerA1);
      return (await tx.query<{ r: { classroom: string; scheduledHours: number; occupiedHours: number; hasCounter: boolean }[] }>(`select public.room_utilization($1, now() - interval '1 day', now()) as r`, [ORG.A])).rows[0]!.r;
    });
    const room = r.find((x) => x.classroom === '102')!;
    expect(room).toMatchObject({ scheduledHours: 2, hasCounter: true });
    expect(room.occupiedHours).toBeGreaterThan(0);
    expect(r.map((x) => x.classroom).sort()).toEqual(['101', '102']); // только филиал A1
  });
});
