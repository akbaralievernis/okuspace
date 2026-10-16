import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectDenied } from '../db/assert';
import { ORG, U, createSeededDb } from '../db/fixtures';
import { as, asMfa, count, rows, type Tx } from '../db/harness';

/**
 * Этап 7: AI выключен по умолчанию, лимиты и бюджет в БД, журнал вызовов закрывает только
 * сервер, история диалогов приватна, AI-отзывы видны ученику, родителю и преподавателю,
 * спор разбирает преподаватель, упражнения проверяются в БД.
 */
let db: PGlite;
const switchTo = (tx: Tx, sub: string, aal: 'aal1' | 'aal2' = 'aal1') =>
  tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aal })]);
const begin = (tx: Tx, reserve = 1000, org: string = ORG.A) =>
  tx.query<{ id: string }>(`select public.ai_begin($1, 'writing_check', $2) as id`, [org, reserve]).then((r) => r.rows[0]!.id);

/** Включить AI для школы A (как директор с MFA) внутри транзакции. */
const enable = async (tx: Tx, opts: { budget?: number; daily?: number } = {}) => {
  await switchTo(tx, U.directorA, 'aal2');
  await tx.query(
    `insert into public.ai_settings (organization_id, enabled, monthly_budget_micro_usd, user_daily_requests, updated_by) values ($1, true, $2, $3, $4)
     on conflict (organization_id) do nothing`,
    [ORG.A, opts.budget ?? 5_000_000, opts.daily ?? 30, U.directorA],
  );
};

beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

describe('AI settings', () => {
  it('AI is off until the school enables it', async () => {
    await expectDenied(as(db, U.studentA1, (tx) => begin(tx)), /ai disabled/);
  });

  it('only the director with MFA enables AI and sets limits; changes are audited', async () => {
    const audited = await as(db, U.studentA1, async (tx) => {
      await enable(tx);
      await switchTo(tx, U.studentA1);
      const visible = await count(tx, 'select 1 from public.ai_settings where enabled');
      await switchTo(tx, U.directorA);
      return { visible, audit: await count(tx, `select 1 from public.audit_logs where entity = 'ai_settings'`) };
    });
    expect(audited).toEqual({ visible: 1, audit: 1 });
    await expectDenied(
      as(db, U.directorA, (tx) =>
        tx.query(`insert into public.ai_settings (organization_id, enabled, monthly_budget_micro_usd, updated_by) values ($1, true, 1, $2)`, [ORG.A, U.directorA]),
      ),
    );
    for (const actor of [U.managerA1, U.adminA1, U.teacherA1, U.studentA1, U.directorB]) {
      await expectDenied(
        asMfa(db, actor, (tx) =>
          tx.query(`insert into public.ai_settings (organization_id, enabled, monthly_budget_micro_usd, updated_by) values ($1, true, 1, $2)`, [ORG.A, actor]),
        ),
      );
    }
  });
});

describe('limits and budget are enforced by the database', () => {
  it('a member can start a call once AI is enabled; outsiders and other schools cannot', async () => {
    const id = await as(db, U.studentA1, async (tx) => {
      await enable(tx);
      await switchTo(tx, U.studentA1);
      return begin(tx);
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    for (const actor of [U.outsider, U.studentB]) {
      await expectDenied(
        as(db, U.studentA1, async (tx) => {
          await enable(tx);
          await switchTo(tx, actor);
          await begin(tx);
        }),
        /not allowed/,
      );
    }
  });

  it('the monthly budget counts finished costs and fresh reservations', async () => {
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx, { budget: 2500 });
        await switchTo(tx, U.studentA1);
        await begin(tx, 1000); // резерв 1000
        await begin(tx, 1000); // резерв 2000
        await begin(tx, 1000); // 3000 > 2500
      }),
      /ai budget exceeded/,
    );
    // Фактическая стоимость заменяет резерв: после закрытия дешёвого вызова место освобождается.
    const ok = await as(db, U.studentA1, async (tx) => {
      await enable(tx, { budget: 2500 });
      await switchTo(tx, U.studentA1);
      const a = await begin(tx, 2000);
      await tx.exec('set local role service_role');
      await tx.query(`select public.ai_finish($1, 'ok', 'claude-opus-5-5', 10, 10, 240)`, [a]);
      await tx.exec('set local role authenticated');
      await begin(tx, 2000); // 240 + 2000 ≤ 2500
      return 'ok';
    });
    expect(ok).toBe('ok');
  });

  it('the per-person daily limit and the per-minute burst limit apply', async () => {
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx, { daily: 2 });
        await switchTo(tx, U.studentA1);
        await begin(tx);
        await begin(tx);
        await begin(tx);
      }),
      /ai daily limit/,
    );
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx, { daily: 100 });
        await switchTo(tx, U.studentA1);
        for (let i = 0; i < 7; i++) await begin(tx);
      }),
      /ai rate limited/,
    );
  });

  it('reservations are bounded', async () => {
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx);
        await switchTo(tx, U.studentA1);
        await begin(tx, 0);
      }),
      /invalid reservation/,
    );
  });
});

describe('the call ledger', () => {
  it('only the server closes a call, exactly once; closed calls are immutable', async () => {
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx);
        await switchTo(tx, U.studentA1);
        const id = await begin(tx);
        await tx.query(`select public.ai_finish($1, 'ok', 'm', 1, 1, 0)`, [id]); // пользователь «удешевляет» вызов
      }),
      /permission denied/,
    );
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx);
        await switchTo(tx, U.studentA1);
        const id = await begin(tx);
        await tx.query(`update public.ai_calls set cost_micro_usd = 0 where id = $1`, [id]);
      }),
      /permission denied/,
    );
    const r = await as(db, U.studentA1, async (tx) => {
      await enable(tx);
      await switchTo(tx, U.studentA1);
      const id = await begin(tx);
      await tx.exec('set local role service_role');
      await tx.query(`select public.ai_finish($1, 'ok', 'claude-opus-5-5', 100, 50, 1400)`, [id]);
      const out: string[] = [];
      for (const sql of [
        `select public.ai_finish($1, 'ok', 'claude-opus-5-5', 1, 1, 0)`,
        `update public.ai_calls set cost_micro_usd = 0 where id = $1`,
        `delete from public.ai_calls where id = $1`,
      ]) {
        await tx.exec('savepoint s');
        try {
          await tx.query(sql, [id]);
          out.push('allowed');
        } catch (e) {
          out.push((e as Error).message);
          await tx.exec('rollback to savepoint s');
        }
      }
      return out;
    });
    expect(r[0]).toMatch(/not pending/);
    expect(r[1]).toMatch(/append-only/);
    expect(r[2]).toMatch(/append-only/);
  });

  it('people see their own calls; the director sees the school usage; teachers do not', async () => {
    const seen = await as(db, U.studentA1, async (tx) => {
      await enable(tx);
      await switchTo(tx, U.studentA1);
      await begin(tx);
      const out: Record<string, number> = {};
      for (const user of [U.studentA1, U.directorA, U.teacherA1, U.parentA1, U.managerA1, U.directorB]) {
        await switchTo(tx, user);
        out[user] = await count(tx, 'select 1 from public.ai_calls');
      }
      return out;
    });
    expect(seen).toEqual({ [U.studentA1]: 1, [U.directorA]: 1, [U.teacherA1]: 0, [U.parentA1]: 0, [U.managerA1]: 0, [U.directorB]: 0 });
  });
});

describe('conversations are private', () => {
  it('the owner writes own turns; assistant turns come only from the server; others see nothing', async () => {
    const r = await as(db, U.studentA1, async (tx) => {
      await enable(tx);
      await switchTo(tx, U.studentA1);
      const conv = (await rows<{ id: string }>(tx, `insert into public.ai_conversations (organization_id, profile_id, scenario, target_language, level) values ($1, $2, 'cafe', 'en', 'A1') returning id`, [ORG.A, U.studentA1]))[0]!.id;
      await tx.query(`insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'Hello')`, [conv]);
      const call = await begin(tx);
      const errors: string[] = [];
      for (const sql of [
        `insert into public.ai_messages (conversation_id, role, content, call_id) values ($1, 'assistant', 'fake', '${call}')`,
        `update public.ai_messages set content = 'edited' where conversation_id = $1`,
      ]) {
        await tx.exec('savepoint s');
        try {
          await tx.query(sql, [conv]);
          errors.push('allowed');
        } catch (e) {
          errors.push((e as Error).message);
          await tx.exec('rollback to savepoint s');
        }
      }
      await tx.exec('set local role service_role');
      await tx.query(`insert into public.ai_messages (conversation_id, role, content, call_id) values ($1, 'assistant', 'Hi! What would you like?', $2)`, [conv, call]);
      await tx.exec('set local role authenticated');
      const seen: Record<string, number> = {};
      for (const user of [U.studentA1, U.teacherA1, U.parentA1, U.directorA]) {
        await switchTo(tx, user);
        seen[user] = await count(tx, 'select 1 from public.ai_messages');
      }
      await switchTo(tx, U.studentA1);
      await tx.query('delete from public.ai_conversations where id = $1', [conv]);
      await tx.exec('set local role service_role');
      const left = await count(tx, 'select 1 from public.ai_messages where conversation_id = $1', [conv]);
      return { errors, seen, left };
    });
    expect(r.errors[0]).toMatch(/row-level security/);
    expect(r.errors[1]).toMatch(/permission denied|append-only/);
    expect(r.seen).toEqual({ [U.studentA1]: 2, [U.teacherA1]: 0, [U.parentA1]: 0, [U.directorA]: 0 });
    expect(r.left).toBe(0);
  });

  it('a conversation cannot be started for someone else or in another school', async () => {
    for (const [profile, org] of [
      [U.studentA1b, ORG.A],
      [U.studentA1, ORG.B],
    ] as const) {
      await expectDenied(
        as(db, U.studentA1, (tx) =>
          tx.query(`insert into public.ai_conversations (organization_id, profile_id, scenario, target_language) values ($1, $2, 'free', 'en')`, [org, profile]),
        ),
      );
    }
  });
});

/** AI-отзыв ученика studentA1 (группа A1, преподаватель teacherA1) — как его сохраняет сервер. */
const feedback = async (tx: Tx, kind = 'writing_check', result: object = { summary: 's', corrections: [{ category: 'grammar' }, { category: 'spelling' }] }) => {
  await enable(tx);
  await switchTo(tx, U.studentA1);
  const call = await begin(tx);
  await tx.exec('set local role service_role');
  const id = (await rows<{ id: string }>(tx, `insert into public.ai_feedback (organization_id, profile_id, kind, input, result, call_id) values ($1, $2, $3, 'I goes home', $4, $5) returning id`, [
    ORG.A, U.studentA1, kind, JSON.stringify(result), call,
  ]))[0]!.id;
  await tx.exec('set local role authenticated');
  return id;
};

describe('AI feedback and disputes', () => {
  it('feedback is saved only by the server and visible to the student, guardian, group teacher and branch leadership', async () => {
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        await enable(tx);
        await switchTo(tx, U.studentA1);
        const call = await begin(tx);
        await tx.query(`insert into public.ai_feedback (organization_id, profile_id, kind, input, result, call_id) values ($1, $2, 'writing_check', 'x', '{}', $3)`, [ORG.A, U.studentA1, call]);
      }),
    );
    const seen = await as(db, U.studentA1, async (tx) => {
      await feedback(tx);
      const out: Record<string, number> = {};
      for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.managerA1, U.directorA, U.teacherA1b, U.studentA1b, U.managerA2, U.directorB]) {
        await switchTo(tx, user);
        out[user] = await count(tx, 'select 1 from public.ai_feedback');
      }
      return out;
    });
    for (const user of [U.studentA1, U.parentA1, U.teacherA1, U.managerA1, U.directorA]) expect(seen[user], user).toBe(1);
    for (const user of [U.teacherA1b, U.studentA1b, U.managerA2, U.directorB]) expect(seen[user], user).toBe(0);
  });

  it('the student or the teacher can dispute; the teacher resolves once with a reason', async () => {
    const r = await as(db, U.studentA1, async (tx) => {
      const fb = await feedback(tx);
      await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'My sentence was correct in context')`, [fb, U.studentA1]);
      await switchTo(tx, U.teacherA1);
      await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'The AI missed an article error')`, [fb, U.teacherA1]);
      const resolved = (await tx.query(
        `update public.ai_feedback_disputes set status = 'upheld', resolution = 'Correct: both forms are fine here', resolved_by = $2, resolved_at = now() where feedback_id = $1 and opened_by = $3`,
        [fb, U.teacherA1, U.studentA1],
      )).affectedRows;
      await switchTo(tx, U.parentA1);
      const parentSees = await count(tx, 'select 1 from public.ai_feedback_disputes where status = $1', ['upheld']);
      const canResolve: Record<string, boolean> = {};
      for (const user of [U.teacherA1, U.managerA1, U.studentA1, U.parentA1, U.teacherA1b]) {
        await switchTo(tx, user);
        canResolve[user] = (await tx.query<{ ok: boolean }>('select public.ai_can_resolve($1) as ok', [fb])).rows[0]!.ok;
      }
      return { resolved, parentSees, canResolve };
    });
    expect(r).toEqual({
      resolved: 1,
      parentSees: 1,
      canResolve: { [U.teacherA1]: true, [U.managerA1]: true, [U.studentA1]: false, [U.parentA1]: false, [U.teacherA1b]: false },
    });
  });

  it('guardians and strangers cannot open disputes; students cannot resolve; decisions are final', async () => {
    for (const actor of [U.parentA1, U.studentA1b, U.teacherA1b]) {
      await expectDenied(
        as(db, U.studentA1, async (tx) => {
          const fb = await feedback(tx);
          await switchTo(tx, actor);
          await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'disagree')`, [fb, actor]);
        }),
      );
    }
    // Ученик не разрешает собственный спор (RLS: обновление не затрагивает строк).
    const own = await as(db, U.studentA1, async (tx) => {
      const fb = await feedback(tx);
      await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'disagree')`, [fb, U.studentA1]);
      return (await tx.query(`update public.ai_feedback_disputes set status = 'upheld', resolution = 'I win', resolved_by = $1, resolved_at = now()`, [U.studentA1])).affectedRows;
    });
    expect(own).toBe(0);
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        const fb = await feedback(tx);
        await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'disagree')`, [fb, U.studentA1]);
        await switchTo(tx, U.teacherA1);
        await tx.query(`update public.ai_feedback_disputes set status = 'rejected', resolution = 'AI was right', resolved_by = $1, resolved_at = now()`, [U.teacherA1]);
        await tx.query(`update public.ai_feedback_disputes set status = 'upheld', resolution = 'changed my mind', resolved_by = $1, resolved_at = now()`, [U.teacherA1]);
      }),
      /already resolved/,
    );
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        const fb = await feedback(tx);
        await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'disagree')`, [fb, U.studentA1]);
        await switchTo(tx, U.teacherA1);
        await tx.query(`update public.ai_feedback_disputes set comment = 'rewritten'`);
      }),
      /permission denied/,
    );
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        const fb = await feedback(tx);
        await tx.query(`insert into public.ai_feedback_disputes (feedback_id, opened_by, comment) values ($1, $2, 'disagree')`, [fb, U.studentA1]);
        await switchTo(tx, U.teacherA1);
        // Нельзя записать решение от чужого имени.
        await tx.query(`update public.ai_feedback_disputes set status = 'rejected', resolution = 'no', resolved_by = $1, resolved_at = now()`, [U.managerA1]);
      }),
      /not allowed to resolve|row-level security/,
    );
  });
});

describe('practice is graded by the database, not by the model', () => {
  const EXERCISES = {
    exercises: [
      { id: 'e1', prompt: 'She ___ to school.', accepted: ['goes'], hint: '', explanation: 'x', category: 'grammar' },
      { id: 'e2', prompt: 'I ___ a student.', accepted: ['am', "'m"], hint: '', explanation: 'x', category: 'grammar' },
      { id: 'e3', prompt: 'They ___ tired.', accepted: ['are'], hint: '', explanation: 'x', category: 'grammar' },
    ],
  };

  it('normalises answers, stores the result and feeds the progress stats', async () => {
    const r = await as(db, U.studentA1, async (tx) => {
      const fb = await feedback(tx, 'exercises', EXERCISES);
      const result = (await tx.query<{ r: { correct: number; total: number } }>(`select public.record_practice($1, $2) as r`, [fb, JSON.stringify({ e1: '  GOES ', e2: 'is', e3: '' })])).rows[0]!.r;
      const wf = await feedback(tx);
      void wf;
      const stats = (await tx.query<{ r: Record<string, unknown> }>('select public.ai_lab_stats() as r')).rows[0]!.r;
      await switchTo(tx, U.parentA1);
      const parent = (await tx.query<{ r: Record<string, unknown> }>('select public.ai_lab_stats($1) as r', [U.studentA1])).rows[0]!.r;
      return { result, stats, parent };
    });
    expect(r.result).toMatchObject({ correct: 1, total: 3 });
    expect(r.stats).toMatchObject({ writingChecks: 1, corrections: { grammar: 1, spelling: 1 }, practice: { sets: 1, correct: 1, total: 3 } });
    expect(r.parent).toEqual(r.stats);
  });

  it('only the owner records practice; stats are not visible to unrelated people', async () => {
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        const fb = await feedback(tx, 'exercises', EXERCISES);
        await switchTo(tx, U.studentA1b);
        await tx.query(`select public.record_practice($1, '{}')`, [fb]);
      }),
      /not available/,
    );
    await expectDenied(
      as(db, U.studentA1, async (tx) => {
        const fb = await feedback(tx); // не упражнения
        await tx.query(`select public.record_practice($1, '{}')`, [fb]);
      }),
      /not available/,
    );
    for (const actor of [U.studentA1b, U.teacherA1b, U.directorB]) {
      await expectDenied(as(db, actor, (tx) => tx.query('select public.ai_lab_stats($1)', [U.studentA1])), /not allowed/);
    }
    await expect(as(db, U.teacherA1, (tx) => tx.query('select public.ai_lab_stats($1)', [U.studentA1]))).resolves.toBeDefined();
  });
});
