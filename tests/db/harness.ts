import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const ROOT = join(__dirname, '..', '..');
export const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const SHIM = join(__dirname, 'supabase-shim.sql');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

/** Чистая БД: shim Supabase + все миграции по порядку. */
export async function createMigratedDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec(readFileSync(SHIM, 'utf8'));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return db;
}

export type Tx = Transaction;

export interface AsOptions {
  /** Уровень аутентификации: aal2 — пользователь прошёл MFA. */
  aal?: 'aal1' | 'aal2';
  /** По умолчанию изменения откатываются, чтобы тесты не влияли друг на друга. */
  commit?: boolean;
  /** Дополнительные claims JWT (email, session_id), как их выдаёт Supabase Auth. */
  claims?: Record<string, unknown>;
}

async function run<T>(db: PGlite, role: string, claims: object, fn: (tx: Tx) => Promise<T>, commit: boolean): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec(`set local role ${role}`);
    const result = await fn(tx);
    if (!commit) await tx.rollback();
    return result;
  });
}

/**
 * Выполнить fn от имени пользователя так же, как это делает PostgREST:
 * роль authenticated (или anon при userId = null) + request.jwt.claims.
 * Ошибка внутри fn откатывает транзакцию и пробрасывается наружу.
 */
export async function as<T>(db: PGlite, userId: string | null, fn: (tx: Tx) => Promise<T>, options: AsOptions = {}): Promise<T> {
  const claims = userId
    ? { sub: userId, role: 'authenticated', aal: options.aal ?? 'aal1', ...options.claims }
    : { role: 'anon' };
  return run(db, userId ? 'authenticated' : 'anon', claims, fn, options.commit ?? false);
}

/** Как service role: обходит RLS, но не триггеры целостности. */
export async function asService<T>(db: PGlite, fn: (tx: Tx) => Promise<T>, options: { commit?: boolean } = {}): Promise<T> {
  return run(db, 'service_role', { role: 'service_role' }, fn, options.commit ?? false);
}

export async function rows<T = Record<string, unknown>>(tx: Tx | PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}

export async function count(tx: Tx | PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const result = await tx.query<{ n: number | string }>(`select count(*)::int as n from (${sql}) q`, params);
  return Number(result.rows[0]?.n ?? 0);
}

/** То же, что as(), но пользователь прошёл MFA (aal2) — для привилегированных действий. */
export async function asMfa<T>(db: PGlite, userId: string, fn: (tx: Tx) => Promise<T>, options: Omit<AsOptions, 'aal'> = {}): Promise<T> {
  return as(db, userId, fn, { ...options, aal: 'aal2' });
}
