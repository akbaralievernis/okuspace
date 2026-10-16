import { describe, expect, it } from 'vitest';
import { describeAnswer } from '@/server/lms/queries';

const options = [
  { id: 'a', text: 'cat' },
  { id: 'b', text: 'dog' },
  { id: 'c', text: 'bird' },
];

describe('describeAnswer renders answers and keys for review', () => {
  it('choice questions show option texts, not ids', () => {
    expect(describeAnswer('single_choice', { option: 'b' }, options)).toBe('dog');
    expect(describeAnswer('multiple_choice', { options: ['a', 'c'] }, options)).toBe('cat, bird');
  });

  it('short text shows the answer, or all accepted variants of a key', () => {
    expect(describeAnswer('short_text', { text: 'went' }, [])).toBe('went');
    expect(describeAnswer('short_text', { accepted: ['went', 'had gone'] }, [])).toBe('went / had gone');
  });

  it('gap fill joins gaps; key alternatives are separated by "/"', () => {
    expect(describeAnswer('gap_fill', { gaps: ['is', ''] }, [])).toBe('is · ');
    expect(describeAnswer('gap_fill', { gaps: [['is'], ['are', 'were']] }, [])).toBe('is · are / were');
  });

  it('missing or malformed values give an empty string (shown as "no answer")', () => {
    expect(describeAnswer('single_choice', null, options)).toBe('');
    expect(describeAnswer('single_choice', {}, options)).toBe('');
    expect(describeAnswer('multiple_choice', { options: 'a' }, options)).toBe('');
  });
});
