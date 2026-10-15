import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvError, getPublicEnv, parseEnv, publicEnvSchema } from '@/lib/env';
import { getServerEnv, serverEnvSchema } from '@/server/env';

const validPublic = {
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdef',
};

afterEach(() => vi.unstubAllEnvs());

describe('public env', () => {
  it('parses a valid configuration', () => {
    expect(parseEnv('public', publicEnvSchema, validPublic)).toEqual(validPublic);
  });

  it('reads NEXT_PUBLIC_* from process.env', () => {
    for (const [k, v] of Object.entries(validPublic)) vi.stubEnv(k, v);
    expect(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co');
  });

  it('reports invalid variable names but never their values', () => {
    const bad = { ...validPublic, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url-but-a-leaky-value' };
    try {
      parseEnv('public', publicEnvSchema, bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).invalidKeys).toEqual(['NEXT_PUBLIC_SUPABASE_URL']);
      expect((e as Error).message).not.toContain('leaky-value');
    }
  });
});

describe('server env', () => {
  it('requires the secret key and defaults LOG_LEVEL', () => {
    expect(parseEnv('server', serverEnvSchema, { SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdef' })).toEqual({
      SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdef',
      LOG_LEVEL: 'info',
    });
    expect(() => parseEnv('server', serverEnvSchema, {})).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it('getServerEnv fails without the secret, without leaking other values', () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '');
    vi.stubEnv('LOG_LEVEL', 'verbose-leak');
    expect(() => getServerEnv()).toThrow(EnvError);
    try {
      getServerEnv();
    } catch (e) {
      expect((e as Error).message).not.toContain('verbose-leak');
    }
  });
});
