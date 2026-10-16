import { describe, expect, it } from 'vitest';
import { addMoney, compareMoney, formatMoney, subMoney } from '@/server/finance/constants';

describe('money helpers work on exact decimal strings', () => {
  it('compares without floating point', () => {
    expect(compareMoney('0.30', '0.3')).toBe(0);
    expect(compareMoney('100000000000.01', '100000000000.00')).toBe(1);
    expect(compareMoney('4999.99', '5000')).toBe(-1);
    expect(compareMoney('-1.00', '0')).toBe(-1);
    // В float 0.1 + 0.2 !== 0.3; строки сравниваются точно.
    expect(compareMoney('0.30', String(0.1 + 0.2).slice(0, 4))).toBe(0);
  });

  it('formats with thousands separators and exactly two decimals', () => {
    expect(formatMoney('4500')).toBe('4 500.00 KGS');
    expect(formatMoney('1234567.5', 'USD')).toBe('1 234 567.50 USD');
    expect(formatMoney('-400.00')).toBe('−400.00 KGS');
    expect(formatMoney(null)).toBe('0.00 KGS');
  });

  it('adds and subtracts exactly', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(addMoney('99999999999.99', '0.01')).toBe('100000000000.00');
    expect(subMoney('4000.00', '400.5')).toBe('3599.50');
    expect(subMoney('1.00', '1.01')).toBe('-0.01');
    expect(addMoney()).toBe('0.00');
  });
});
