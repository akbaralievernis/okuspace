/** Справочники финансов — совпадают с CHECK-ограничениями миграций 0005 и 20261021100000. */
export const METHODS = ['cash', 'card', 'bank_transfer', 'online'] as const;
export const EXPENSE_CATEGORIES = ['rent', 'salary', 'utilities', 'marketing', 'supplies', 'taxes', 'other'] as const;
export const TARIFF_UNITS = ['month', 'lesson', 'course', 'hour', 'package'] as const;

/** Сравнение десятичных строк денег без float: через целые копейки. */
export function compareMoney(a: string, b: string): number {
  const cents = (s: string) => {
    const neg = s.trim().startsWith('-');
    const [i, f = ''] = s.trim().replace('-', '').split('.');
    const v = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
    return neg ? -v : v;
  };
  const d = cents(a) - cents(b);
  return d === 0n ? 0 : d > 0n ? 1 : -1;
}

/** Формат суммы для показа: группы разрядов, ровно два знака; расчётов не делает. */
export function formatMoney(amount: string | number | null | undefined, currency = 'KGS'): string {
  const s = String(amount ?? '0');
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const grouped = (i || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${grouped}.${(f + '00').slice(0, 2)} ${currency}`;
}

const toCents = (s: string): bigint => {
  const t = s.trim();
  const neg = t.startsWith('-');
  const [i, f = ''] = t.replace('-', '').split('.');
  return (neg ? -1n : 1n) * (BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2)));
};
const fromCents = (c: bigint): string => {
  const a = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

/** Сумма и разность денежных строк — точно, через целые копейки. */
export const addMoney = (...xs: string[]) => fromCents(xs.reduce((s, x) => s + toCents(x), 0n));
export const subMoney = (a: string, b: string) => fromCents(toCents(a) - toCents(b));
