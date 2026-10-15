import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { BRANCH, ORG, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, asService, count, rows, type Tx } from '../db/harness';

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

const TOKEN = 'tok_' + 'a1b2c3d4'.repeat(6); // 52 символа, как base64url-токен сервера
const emailOf = (name: keyof typeof U) => `${name.toLowerCase()}@example.test`;

const createInvitation = (tx: Tx, opts: { email: string; role?: string; branch?: string | null; by: string; token?: string; org?: string }) =>
  tx.query(
    `insert into public.invitations (organization_id, branch_id, email, role, token_hash, expires_at, created_by)
     values ($1, $2, $3, $4, encode(sha256(convert_to($5, 'UTF8')), 'hex'), now() + interval '3 days', $6)`,
    [opts.org ?? ORG.A, opts.branch === undefined ? BRANCH.A1 : opts.branch, opts.email, opts.role ?? 'teacher', opts.token ?? TOKEN, opts.by],
  );

const switchTo = (tx: Tx, user: string, extra: Record<string, unknown> = {}) =>
  tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated', ...extra })]);

const accept = (tx: Tx, token: string = TOKEN) => tx.query<{ id: string }>('select public.accept_invitation($1) as id', [token]);

describe('MFA is required for privileged account management', () => {
  it('granting roles without MFA is denied, with MFA allowed', async () => {
    const grant = (tx: Tx) =>
      tx.query(`insert into public.memberships (organization_id, branch_id, profile_id, role) values ($1, $2, $3, 'teacher')`, [
        ORG.A, BRANCH.A1, U.outsider,
      ]);
    await expectDenied(as(db, U.adminA1, grant));
    await expect(asMfa(db, U.adminA1, grant)).resolves.toBeDefined();
  });

  it('blocking a member without MFA affects nothing', async () => {
    const block = (tx: Tx) =>
      tx.query(`update public.memberships set status = 'blocked', status_reason = 'x' where profile_id = $1`, [U.teacherA1]);
    expect((await as(db, U.directorA, block)).affectedRows).toBe(0);
    expect((await asMfa(db, U.directorA, block)).affectedRows).toBe(1);
  });

  it('invitations, guardian links and organizations require MFA', async () => {
    await expectDenied(as(db, U.adminA1, (tx) => createInvitation(tx, { email: 'x@example.test', by: U.adminA1 })));
    await expectDenied(
      as(db, U.adminA1, (tx) =>
        tx.query(`insert into public.guardian_links (organization_id, guardian_id, student_id) values ($1, $2, $3)`, [ORG.A, U.parentA1, U.studentA1b]),
      ),
    );
    await expectDenied(as(db, U.platform, (tx) => tx.query(`insert into public.organizations (name, slug) values ('X', 'x-school')`)));
  });
});

describe('accept_invitation', () => {
  it('creates the membership once, bound to the invited email', async () => {
    const result = await asMfa(db, U.adminA1, async (tx) => {
      await createInvitation(tx, { email: emailOf('outsider'), by: U.adminA1 });
      await switchTo(tx, U.outsider, { email: emailOf('outsider') });
      const first = await accept(tx);
      const membership = await rows<{ role: string; branch_id: string; created_by: string; status: string }>(
        tx,
        'select role, branch_id, created_by, status from public.memberships where id = $1',
        [first.rows[0]!.id],
      );
      const invitation = await rows<{ accepted_by: string }>(tx, `select accepted_by from public.invitations where email = $1`, [emailOf('outsider')]);
      return { membership: membership[0], invitation: invitation[0] };
    });
    expect(result.membership).toEqual({ role: 'teacher', branch_id: BRANCH.A1, created_by: U.adminA1, status: 'active' });
    expect(result.invitation).toBeUndefined(); // приглашение видят только выдающие роли, не приглашённый
  });

  it('cannot be reused', async () => {
    await expectDenied(
      asMfa(db, U.adminA1, async (tx) => {
        await createInvitation(tx, { email: emailOf('outsider'), by: U.adminA1 });
        await switchTo(tx, U.outsider, { email: emailOf('outsider') });
        await accept(tx);
        await accept(tx);
      }),
      /invalid invitation/,
    );
  });

  it('is rejected for another email, with the same generic error', async () => {
    await expectDenied(
      asMfa(db, U.adminA1, async (tx) => {
        await createInvitation(tx, { email: emailOf('outsider'), by: U.adminA1 });
        await switchTo(tx, U.studentA1b, { email: emailOf('studentA1b') });
        await accept(tx);
      }),
      /^invalid invitation$/,
    );
  });

  it('is rejected for a wrong, short or missing token', async () => {
    for (const token of ['tok_' + 'z'.repeat(48), 'short', '']) {
      await expectDenied(
        as(db, U.outsider, (tx) => accept(tx, token), { claims: { email: emailOf('outsider') } }),
        /invalid invitation/,
      );
    }
  });

  it('is rejected when revoked or expired', async () => {
    await expectDenied(
      asMfa(db, U.adminA1, async (tx) => {
        await createInvitation(tx, { email: emailOf('outsider'), by: U.adminA1 });
        await tx.query(`update public.invitations set revoked_at = now() where email = $1`, [emailOf('outsider')]);
        await switchTo(tx, U.outsider, { email: emailOf('outsider') });
        await accept(tx);
      }),
      /invalid invitation/,
    );
    await expectDenied(
      db.transaction(async (tx) => {
        await tx.query(
          `insert into public.invitations (organization_id, branch_id, email, role, token_hash, created_at, expires_at, created_by)
           values ($1, $2, $3, 'teacher', encode(sha256(convert_to($4, 'UTF8')), 'hex'), now() - interval '5 days', now() - interval '1 day', $5)`,
          [ORG.A, BRANCH.A1, emailOf('outsider'), TOKEN, U.adminA1],
        );
        await switchTo(tx, U.outsider, { email: emailOf('outsider') });
        await tx.exec('set local role authenticated');
        await accept(tx);
      }),
      /invalid invitation/,
    );
  });

  it('is rejected when the inviter has lost the right to grant the role', async () => {
    await expectDenied(
      asMfa(db, U.adminA1, async (tx) => {
        await createInvitation(tx, { email: emailOf('outsider'), by: U.adminA1 });
        await switchTo(tx, U.directorA, { aal: 'aal2' });
        await tx.query(`update public.memberships set status = 'blocked', status_reason = 'left' where profile_id = $1`, [U.adminA1]);
        await switchTo(tx, U.outsider, { email: emailOf('outsider') });
        await accept(tx);
      }),
      /invalid invitation/,
    );
  });

  it('reports an existing membership instead of duplicating it', async () => {
    await expectDenied(
      asMfa(db, U.adminA1, async (tx) => {
        await createInvitation(tx, { email: emailOf('studentA1'), role: 'student', by: U.adminA1 });
        await switchTo(tx, U.studentA1, { email: emailOf('studentA1') });
        await accept(tx);
      }),
      /membership already exists/,
    );
  });

  it('requires authentication', async () => {
    await expectDenied(as(db, null, (tx) => accept(tx)), /permission denied/);
  });

  it('platform admins invite directors; directors cannot', async () => {
    const role = await asMfa(db, U.platform, async (tx) => {
      await createInvitation(tx, { email: emailOf('outsider'), role: 'org_director', branch: null, by: U.platform });
      await switchTo(tx, U.outsider, { email: emailOf('outsider') });
      const { rows: r } = await accept(tx);
      return (await rows<{ role: string }>(tx, 'select role from public.memberships where id = $1', [r[0]!.id]))[0]?.role;
    });
    expect(role).toBe('org_director');
    await expectDenied(asMfa(db, U.directorA, (tx) => createInvitation(tx, { email: 'd@example.test', role: 'org_director', branch: null, by: U.directorA })));
    await expectDenied(asMfa(db, U.platform, (tx) => createInvitation(tx, { email: 'd@example.test', role: 'teacher', by: U.platform })));
  });
});

describe('hit_rate_limit', () => {
  const bucket = 'login:' + 'ab'.repeat(32);

  it('allows up to the limit within a window, then refuses', async () => {
    const results = await asService(db, async (tx) => {
      const out: boolean[] = [];
      for (let i = 0; i < 4; i++) out.push((await tx.query<{ ok: boolean }>('select public.hit_rate_limit($1, 3, 60) as ok', [bucket])).rows[0]!.ok);
      return out;
    });
    expect(results).toEqual([true, true, true, false]);
  });

  it('is not callable from the browser roles and does not store raw identifiers', async () => {
    await expectDenied(as(db, U.studentA1, (tx) => tx.query('select public.hit_rate_limit($1, 3, 60)', [bucket])), /permission denied/);
    await expectDenied(as(db, null, (tx) => tx.query('select public.hit_rate_limit($1, 3, 60)', [bucket])), /permission denied/);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query('select * from public.rate_limits')), /permission denied/);
    await expectDenied(
      asService(db, (tx) => tx.query(`select public.hit_rate_limit('login:someone@example.test', 3, 60)`)),
      /rate_limits_bucket_check/,
    );
  });
});

describe('list_my_sessions', () => {
  it('returns only the caller’s sessions and marks the current one', async () => {
    const [s1, s2, other] = ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003'];
    const listed = await db.transaction(async (tx) => {
      await tx.query(
        `insert into auth.sessions (id, user_id, updated_at, user_agent, ip, aal) values
         ($1, $4, now(), 'Firefox', '10.0.0.1', 'aal1'), ($2, $4, now() - interval '1 day', 'Safari', '10.0.0.2', 'aal2'),
         ($3, $5, now(), 'Chrome', '10.0.0.3', 'aal1')`,
        [s1, s2, other, U.studentA1, U.studentA1b],
      );
      await switchTo(tx, U.studentA1, { session_id: s1 });
      await tx.exec('set local role authenticated');
      const mine = await rows<{ id: string; is_current: boolean; ip: string }>(tx, 'select id, is_current, ip from public.list_my_sessions()');
      await tx.rollback();
      return mine;
    });
    expect(listed).toEqual([
      { id: s1, is_current: true, ip: '10.0.0.1' },
      { id: s2, is_current: false, ip: '10.0.0.2' },
    ]);
    await expectDenied(as(db, null, (tx) => tx.query('select * from public.list_my_sessions()')), /permission denied/);
  });
});

describe('registration: profile, locale and consents', () => {
  const register = (meta: Record<string, unknown>) =>
    db.transaction(async (tx) => {
      const { rows: r } = await tx.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data) values ('new.user@example.test', $1) returning id`,
        [JSON.stringify(meta)],
      );
      const id = r[0]!.id;
      const profile = await rows<{ full_name: string; locale: string }>(tx, 'select full_name, locale from public.profiles where id = $1', [id]);
      const consents = await rows<{ kind: string; version: string }>(tx, 'select kind, version from public.consents where profile_id = $1 order by kind', [id]);
      const memberships = await count(tx, 'select 1 from public.memberships where profile_id = $1', [id]);
      await tx.rollback();
      return { profile: profile[0], consents, memberships };
    });

  it('records consents and locale from sign-up metadata and grants no roles', async () => {
    const r = await register({ full_name: 'Айгуль', locale: 'ky', consent_version: '2026-10-15' });
    expect(r.profile).toEqual({ full_name: 'Айгуль', locale: 'ky' });
    expect(r.consents).toEqual([
      { kind: 'privacy_policy', version: '2026-10-15' },
      { kind: 'terms', version: '2026-10-15' },
    ]);
    expect(r.memberships).toBe(0);
  });

  it('ignores invalid locale and consent values from the client', async () => {
    const r = await register({ full_name: 'X', locale: 'de', consent_version: 'yes' });
    expect(r.profile?.locale).toBe('ru');
    expect(r.consents).toEqual([]);
  });

  it('consents are append-only and private', async () => {
    await expectDenied(
      asService(db, async (tx) => {
        await tx.exec('reset role');
        await tx.query(`insert into auth.users (email, raw_user_meta_data) values ('c@example.test', '{"consent_version": "2026-10-15"}')`);
        await tx.exec('set local role service_role');
        expect(await count(tx, 'select 1 from public.consents')).toBe(2);
        await tx.query('delete from public.consents');
      }),
      /append-only/,
    );
    await expectDenied(asService(db, (tx) => tx.query('truncate public.consents')), /append-only/);
    await expectDenied(as(db, U.studentA1, (tx) => tx.query(`insert into public.consents (profile_id, kind, version) values ($1, 'terms', '2026-10-15')`, [U.studentA1])));
  });
});

describe('security events about oneself', () => {
  it('a member can read audit entries about their own membership, others cannot', async () => {
    const seen = await asMfa(db, U.directorA, async (tx) => {
      await tx.query(`update public.memberships set status = 'blocked', status_reason = 'policy' where profile_id = $1`, [U.teacherA1b]);
      await switchTo(tx, U.teacherA1b);
      const own = await count(tx, `select 1 from public.audit_logs where entity = 'memberships' and action = 'update'`);
      await switchTo(tx, U.studentA1);
      const foreign = await count(tx, `select 1 from public.audit_logs where subject_profile_id = $1`, [U.teacherA1b]);
      return { own, foreign };
    });
    expect(seen).toEqual({ own: 1, foreign: 0 });
  });
});
