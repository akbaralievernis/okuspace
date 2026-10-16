import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/proxy';

describe('buildCsp', () => {
  it('uses the nonce and strict defaults in production', () => {
    const csp = buildCsp('abc123', { dev: false, supabaseUrl: 'https://x.supabase.co' });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' https://x.supabase.co");
  });

  it('allows eval only in development (needed by the dev server)', () => {
    expect(buildCsp('n', { dev: true })).toContain("'unsafe-eval'");
  });

  it('lesson media may come from https hosts only (no plain http, no frames)', () => {
    const media = buildCsp('n', { dev: false }).split('; ').find((d) => d.startsWith('media-src'));
    expect(media).toBe("media-src 'self' blob: https:");
    expect(buildCsp('n', { dev: false })).not.toContain('frame-src');
  });
});
