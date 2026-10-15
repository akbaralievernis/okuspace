import type { PGlite } from '@electric-sql/pglite';
import { createMigratedDb } from './harness';

/** Детерминированные UUID: удобно читать в сообщениях об ошибках. */
const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n: number) => id('00000000', n);

export const ORG = { A: id('a0000000', 1), B: id('b0000000', 1) } as const;
export const BRANCH = { A1: id('a1000000', 1), A2: id('a2000000', 1), B1: id('b1000000', 1) } as const;

export const U = {
  platform: user(1),
  // Организация A
  directorA: user(10),
  managerA1: user(11),
  adminA1: user(12),
  accountantA: user(13), // на всю организацию
  salesA1: user(14),
  teacherA1: user(15),
  teacherA1b: user(16),
  teacherA2: user(17),
  managerA2: user(18),
  studentA1: user(20),
  studentA1b: user(21),
  studentA2: user(22),
  parentA1: user(23), // опекун studentA1
  // Организация B
  directorB: user(30),
  teacherB: user(31),
  studentB: user(32),
  accountantB: user(33),
  // Без членств
  outsider: user(40),
} as const;

export const LANG = { A: id('1a000000', 1), B: id('1b000000', 1) } as const;
export const LEVEL = { A: id('2a000000', 1), B: id('2b000000', 1) } as const;
export const COURSE = { A: id('3a000000', 1), B: id('3b000000', 1) } as const;
export const ROOM = { A1: id('4a100000', 1), A1x: id('4a100000', 2), A2: id('4a200000', 1) } as const;
export const GROUP = { A1: id('5a100000', 1), A1b: id('5a100000', 2), A2: id('5a200000', 1), B: id('5b000000', 1) } as const;
export const ASSIGN = {
  A1: id('6a100000', 1),
  A1draft: id('6a100000', 2),
  A1b: id('6a100000', 3),
  A2: id('6a200000', 1),
  B: id('6b000000', 1),
} as const;
export const SUB = { A1: id('7a100000', 1), A1b: id('7a100000', 2), A2: id('7a200000', 1), B: id('7b000000', 1) } as const;
export const INVOICE = { A1: id('8a100000', 1), A2: id('8a200000', 1), B: id('8b000000', 1) } as const;
export const PAYMENT = { A1: id('9a100000', 1), A2: id('9a200000', 1), B: id('9b000000', 1) } as const;

const memberships: [string, string, string | null, string][] = [
  // [org, user, branch, role]
  [ORG.A, U.directorA, null, 'org_director'],
  [ORG.A, U.managerA1, BRANCH.A1, 'branch_manager'],
  [ORG.A, U.managerA2, BRANCH.A2, 'branch_manager'],
  [ORG.A, U.adminA1, BRANCH.A1, 'admin'],
  [ORG.A, U.accountantA, null, 'accountant'],
  [ORG.A, U.salesA1, BRANCH.A1, 'sales_manager'],
  [ORG.A, U.teacherA1, BRANCH.A1, 'teacher'],
  [ORG.A, U.teacherA1b, BRANCH.A1, 'teacher'],
  [ORG.A, U.teacherA2, BRANCH.A2, 'teacher'],
  [ORG.A, U.studentA1, BRANCH.A1, 'student'],
  [ORG.A, U.studentA1b, BRANCH.A1, 'student'],
  [ORG.A, U.studentA2, BRANCH.A2, 'student'],
  [ORG.A, U.parentA1, BRANCH.A1, 'parent'],
  [ORG.B, U.directorB, null, 'org_director'],
  [ORG.B, U.teacherB, BRANCH.B1, 'teacher'],
  [ORG.B, U.studentB, BRANCH.B1, 'student'],
  [ORG.B, U.accountantB, null, 'accountant'],
];

const q = (v: string | null) => (v === null ? 'null' : `'${v}'`);

/** SQL фикстур выполняется суперпользователем (как сид в dev/test, не в production). */
function fixtureSql(): string {
  const users = Object.entries(U)
    .map(([name, uid]) => `('${uid}', '${name.toLowerCase()}@example.test', '{"full_name": "${name}"}')`)
    .join(',\n');
  const members = memberships.map(([o, u, b, r]) => `('${o}', ${q(b)}, '${u}', '${r}')`).join(',\n');

  return `
insert into auth.users (id, email, raw_user_meta_data) values ${users};
insert into public.profile_private (profile_id, phone) select id, '+996 700 000 ' || right(id::text, 3) from public.profiles;
insert into public.platform_admins (profile_id) values ('${U.platform}');

insert into public.organizations (id, name, slug) values
  ('${ORG.A}', 'Школа A', 'school-a'), ('${ORG.B}', 'Школа B', 'school-b');
insert into public.branches (id, organization_id, name, city) values
  ('${BRANCH.A1}', '${ORG.A}', 'A1', 'Бишкек'), ('${BRANCH.A2}', '${ORG.A}', 'A2', 'Ош'),
  ('${BRANCH.B1}', '${ORG.B}', 'B1', 'Бишкек');
insert into public.memberships (organization_id, branch_id, profile_id, role) values ${members};
insert into public.guardian_links (organization_id, guardian_id, student_id) values ('${ORG.A}', '${U.parentA1}', '${U.studentA1}');

insert into public.languages (id, organization_id, code, name) values
  ('${LANG.A}', '${ORG.A}', 'en', 'English'), ('${LANG.B}', '${ORG.B}', 'en', 'English');
insert into public.course_levels (id, organization_id, language_id, code, title, sort_order) values
  ('${LEVEL.A}', '${ORG.A}', '${LANG.A}', 'A1', 'Beginner', 1), ('${LEVEL.B}', '${ORG.B}', '${LANG.B}', 'A1', 'Beginner', 1);
insert into public.courses (id, organization_id, language_id, level_id, title, format, kind, duration_weeks, status) values
  ('${COURSE.A}', '${ORG.A}', '${LANG.A}', '${LEVEL.A}', 'General English A1', 'offline', 'group', 12, 'published'),
  ('${COURSE.B}', '${ORG.B}', '${LANG.B}', '${LEVEL.B}', 'English A1', 'online', 'group', 12, 'published');

insert into public.classrooms (id, organization_id, branch_id, name, capacity) values
  ('${ROOM.A1}', '${ORG.A}', '${BRANCH.A1}', '101', 12), ('${ROOM.A1x}', '${ORG.A}', '${BRANCH.A1}', '102', 12),
  ('${ROOM.A2}', '${ORG.A}', '${BRANCH.A2}', '201', 12);
insert into public.groups (id, organization_id, branch_id, course_id, name, capacity, starts_on) values
  ('${GROUP.A1}', '${ORG.A}', '${BRANCH.A1}', '${COURSE.A}', 'EN-A1-1', 2, '2026-11-01'),
  ('${GROUP.A1b}', '${ORG.A}', '${BRANCH.A1}', '${COURSE.A}', 'EN-A1-2', 10, '2026-11-01'),
  ('${GROUP.A2}', '${ORG.A}', '${BRANCH.A2}', '${COURSE.A}', 'EN-A1-OSH', 10, '2026-11-01'),
  ('${GROUP.B}', '${ORG.B}', '${BRANCH.B1}', '${COURSE.B}', 'B-EN-1', 10, '2026-11-01');
insert into public.group_teachers (organization_id, branch_id, group_id, teacher_id) values
  ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}'),
  ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1b}', '${U.teacherA1b}'),
  ('${ORG.A}', '${BRANCH.A2}', '${GROUP.A2}', '${U.teacherA2}'),
  ('${ORG.B}', '${BRANCH.B1}', '${GROUP.B}', '${U.teacherB}');
insert into public.enrollments (organization_id, branch_id, group_id, student_id, status) values
  ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.studentA1}', 'active'),
  ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1b}', '${U.studentA1b}', 'active'),
  ('${ORG.A}', '${BRANCH.A2}', '${GROUP.A2}', '${U.studentA2}', 'active'),
  ('${ORG.B}', '${BRANCH.B1}', '${GROUP.B}', '${U.studentB}', 'active');
insert into public.lesson_sessions (organization_id, branch_id, group_id, teacher_id, classroom_id, period) values
  ('${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', '${U.teacherA1}', '${ROOM.A1}', '[2026-11-02 10:00+06, 2026-11-02 11:30+06)');

insert into public.assignments (id, organization_id, branch_id, group_id, title, max_score, status, created_by) values
  ('${ASSIGN.A1}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', 'Essay A1', 10, 'published', '${U.teacherA1}'),
  ('${ASSIGN.A1draft}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1}', 'Draft A1', 10, 'draft', '${U.teacherA1}'),
  ('${ASSIGN.A1b}', '${ORG.A}', '${BRANCH.A1}', '${GROUP.A1b}', 'Essay A1b', 10, 'published', '${U.teacherA1b}'),
  ('${ASSIGN.A2}', '${ORG.A}', '${BRANCH.A2}', '${GROUP.A2}', 'Essay A2', 10, 'published', '${U.teacherA2}'),
  ('${ASSIGN.B}', '${ORG.B}', '${BRANCH.B1}', '${GROUP.B}', 'Essay B', 10, 'published', '${U.teacherB}');
insert into public.assignment_submissions (id, organization_id, branch_id, assignment_id, student_id, body) values
  ('${SUB.A1}', '${ORG.A}', '${BRANCH.A1}', '${ASSIGN.A1}', '${U.studentA1}', 'My essay'),
  ('${SUB.A1b}', '${ORG.A}', '${BRANCH.A1}', '${ASSIGN.A1b}', '${U.studentA1b}', 'Other essay'),
  ('${SUB.A2}', '${ORG.A}', '${BRANCH.A2}', '${ASSIGN.A2}', '${U.studentA2}', 'Osh essay'),
  ('${SUB.B}', '${ORG.B}', '${BRANCH.B1}', '${ASSIGN.B}', '${U.studentB}', 'B essay');

insert into public.invoices (id, organization_id, branch_id, payer_id, number, total, status, created_by) values
  ('${INVOICE.A1}', '${ORG.A}', '${BRANCH.A1}', '${U.studentA1}', 'A-0001', 5000.00, 'issued', '${U.accountantA}'),
  ('${INVOICE.A2}', '${ORG.A}', '${BRANCH.A2}', '${U.studentA2}', 'A-0002', 5000.00, 'issued', '${U.accountantA}'),
  ('${INVOICE.B}', '${ORG.B}', '${BRANCH.B1}', '${U.studentB}', 'B-0001', 4000.00, 'issued', '${U.accountantB}');
insert into public.payments (id, organization_id, branch_id, payer_id, kind, amount, currency, method, created_by) values
  ('${PAYMENT.A1}', '${ORG.A}', '${BRANCH.A1}', '${U.studentA1}', 'payment', 3000.00, 'KGS', 'cash', '${U.accountantA}'),
  ('${PAYMENT.A2}', '${ORG.A}', '${BRANCH.A2}', '${U.studentA2}', 'payment', 5000.00, 'KGS', 'card', '${U.accountantA}'),
  ('${PAYMENT.B}', '${ORG.B}', '${BRANCH.B1}', '${U.studentB}', 'payment', 4000.00, 'KGS', 'cash', '${U.accountantB}');
`;
}

/** Мигрированная БД с фикстурами двух школ. */
export async function createSeededDb(): Promise<PGlite> {
  const db = await createMigratedDb();
  try {
    await db.exec(fixtureSql());
  } catch (error) {
    throw new Error(`Fixtures failed: ${(error as Error).message}`, { cause: error });
  }
  return db;
}
