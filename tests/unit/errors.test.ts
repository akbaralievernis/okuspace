import { describe, expect, it } from 'vitest';
import { AppError, toPublicError } from '@/lib/errors';

describe('toPublicError', () => {
  it('passes through expected domain errors', () => {
    const err = new AppError('VALIDATION', 'Проверьте поля', { fieldErrors: { email: ['Неверный email'] } });
    expect(toPublicError(err, 'req-1')).toEqual({
      code: 'VALIDATION',
      message: 'Проверьте поля',
      fieldErrors: { email: ['Неверный email'] },
      requestId: 'req-1',
    });
  });

  it('hides details of unexpected errors', () => {
    const pub = toPublicError(new Error('relation "payments" does not exist at character 15'));
    expect(pub.code).toBe('INTERNAL');
    expect(pub.message).not.toContain('payments');
    expect(pub).not.toHaveProperty('stack');
  });

  it('hides the message of INTERNAL AppErrors', () => {
    expect(toPublicError(new AppError('INTERNAL', 'db password wrong')).message).not.toContain('password');
  });

  it('handles non-Error throwables', () => {
    expect(toPublicError('string thrown').code).toBe('INTERNAL');
  });
});
