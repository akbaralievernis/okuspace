import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, redact } from '@/lib/logger';

describe('redact', () => {
  it('masks sensitive keys at any depth, including arrays', () => {
    const out = redact({
      user: 'u1',
      password: 'p@ss',
      nested: { apiKey: 'k', Authorization: 'Bearer x', items: [{ refresh_token: 't', ok: 1 }] },
      SUPABASE_SECRET_KEY: 'sb_secret_x',
      cookie: 'a=b',
    });
    expect(out).toEqual({
      user: 'u1',
      password: REDACTED,
      nested: { apiKey: REDACTED, Authorization: REDACTED, items: [{ refresh_token: REDACTED, ok: 1 }] },
      SUPABASE_SECRET_KEY: REDACTED,
      cookie: REDACTED,
    });
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[Circular]' });
  });

  it('serialises errors without stack traces', () => {
    const out = redact({ err: new Error('boom') }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: 'Error', message: 'boom' });
  });
});

describe('createLogger', () => {
  it('writes structured JSON, applies level and redaction', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (_level, line) => lines.push(line) });
    log.debug('hidden');
    log.child({ requestId: 'r1' }).info('login', { email: 'a@example.test', password: 'secret' });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry).toMatchObject({ level: 'info', msg: 'login', requestId: 'r1', email: 'a@example.test', password: REDACTED });
    expect(lines[0]).not.toContain('secret');
  });
});
