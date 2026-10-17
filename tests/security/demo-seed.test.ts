import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import DEMO_USERS from '../../supabase/demo/users.json';
import { as, count, createMigratedDb, rows } from '../db/harness';

const SEED = readFileSync(join(__dirname, '..', '..', 'supabase', 'demo', 'seed.sql'), 'utf8');
const ORG = 'de000000-0000-4000-8000-000000000001';
let db: PGlite;
const uid = async (email: string) => (await rows<{ id: string }>(db, 'select id from auth.users where email = $1', [email]))[0]!.id;

beforeAll(async () => {
  db = await createMigratedDb();
  // В Supabase пользователей создаёт `npm run demo:users` (Auth Admin API); здесь — напрямую.
  for (const u of DEMO_USERS) await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2)', [u.email, { full_name: u.name }]);
  await db.exec(SEED);
}, 120_000);

describe('demo seed', () => {
  it('loads on a clean database with every module populated', async () => {
    const n = async (table: string) => count(db, `select 1 from public.${table} where organization_id = $1`, [ORG]);
    expect(await n('memberships')).toBe(DEMO_USERS.length);
    expect(await n('lesson_sessions')).toBeGreaterThanOrEqual(18);
    expect(await n('attendance_records')).toBeGreaterThan(0);
    expect(await n('assessment_questions')).toBe(3);
    expect(await n('invoices')).toBe(3);
    expect(await n('crm_contacts')).toBe(4);
    expect(await n('legal_documents')).toBe(9);
    expect(await n('trial_slots')).toBe(3);
    expect(await n('staff_tasks')).toBe(4);
    expect(await n('announcements')).toBe(2);
    expect(await n('group_exams')).toBe(1);
    expect(await n('report_cards')).toBe(2);
    expect(await n('assignments')).toBe(3);
    // Триггеры событий уже создали уведомления: задания, проверка, пропуски, серия пропусков.
    const kinds = (await rows<{ kind: string }>(db, 'select distinct kind from public.notifications where organization_id = $1', [ORG])).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['homework_assigned', 'submission_received', 'homework_graded', 'absence_alert', 'manager_alert', 'task_assigned', 'announcement_ack', 'announcement', 'exam_result']));
  });

  it('is not loaded twice', async () => {
    await expect(db.exec(SEED)).rejects.toThrow(/уже загружены/);
  });

  it('demo users see their own data through RLS', async () => {
    const student = await uid('student@example.com');
    const teacher2 = await uid('teacher2@example.com');
    const parent = await uid('parent@example.com');
    expect(await as(db, student, (tx) => count(tx, 'select 1 from public.invoices'))).toBe(1);
    expect(await as(db, parent, (tx) => count(tx, 'select 1 from public.invoices'))).toBe(1);
    expect(await as(db, teacher2, (tx) => count(tx, 'select 1 from public.assignments'))).toBe(0);
    expect(await as(db, student, (tx) => count(tx, `select 1 from public.notifications where kind = 'homework_graded'`))).toBe(1);
  });

  it('the public site of the demo school is open', async () => {
    const [r] = await as(db, null, (tx) =>
      rows<{ site: unknown; teachers: unknown[]; catalog: unknown; legal: unknown }>(
        tx,
        `select public_site('demo') as site, public_teachers('demo') as teachers, public_catalog('demo') as catalog, public_legal('demo', 'privacy', 'ru') as legal`,
      ),
    );
    expect(r!.site).not.toBeNull();
    expect(r!.teachers).toHaveLength(2);
    expect(JSON.stringify(r!.catalog)).toContain('General English A2');
    expect(r!.legal).not.toBeNull();
  });
});
