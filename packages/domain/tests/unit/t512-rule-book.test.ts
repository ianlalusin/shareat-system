import { describe, expect, it } from 'vitest';
import { RULE_REGISTRY, type BusinessRuleKey } from '../../src/business-rules/registry';
import { buildRuleBook } from '../../src/business-rules/book';

/**
 * T-512 (T-511 S5c) TESTER - the pure half of the rule reader: which row is "in force" on a date, and the exact conversions. docs/tasks/512-business-rules-s5c-spec.md
 * "Table" (rule in force = greatest (effective_from, created_at, id) with effective_from <= date) and "Reader and writer" (money as bigint centavos, percent x 100 as basis points).
 *
 * RED today: `packages/domain/src/business-rules/book.ts` does not exist (module not found).
 *
 * ASSUMPTION beyond the agreed list (builders must follow it): the pure core of `loadRuleBook` is a separately exported sync function
 *   buildRuleBook(rows: readonly { id: string; key: string; value: string; effectiveFrom: string; createdAt: Date }[]): RuleBook
 * in packages/domain/src/business-rules/book.ts, and `loadRuleBook(tx, orgId, keys)` is "ONE query, then buildRuleBook". `book.valueOn(key, date)` returns the registry default
 * for a key with no row in force, and THROWS for a key outside the registry. `centavos()` / `basisPoints()` THROW on a value that is not exactly a whole centavo / whole basis point
 * (a stored 0.005 money is never silently rounded). `text` renders the stored number (the tests read it only through Number(...)).
 *
 * The same scenarios run again against a real table in t512-business-rules.test.ts, through `loadRuleBook`.
 */
const FLOOR: BusinessRuleKey = 'settlement.variance_floor_amount';
const PERCENT: BusinessRuleKey = 'settlement.variance_percent';
const LOAN: BusinessRuleKey = 'settlement.loan_final_tolerance';
const WITHHOLDING: BusinessRuleKey = 'tax.withholding_rate_percent';
const VAT: BusinessRuleKey = 'tax.vat_percent';

let n = 0;
type Row = { id: string; key: string; value: string; effectiveFrom: string; createdAt: Date };
const row = (key: string, value: string, effectiveFrom: string, o: { id?: string; at?: string } = {}): Row => ({
  id: o.id ?? `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  key,
  value,
  effectiveFrom,
  createdAt: new Date(o.at ?? '2026-11-01T00:00:00.000Z'),
});
const num = (t: string): number => Number(t);

describe('T-512 rule book - nothing recorded: the registry default', () => {
  it('every key answers its default, as exact bigints [kills: a default that moved; a float on the way]', () => {
    const book = buildRuleBook([]);
    expect(book.valueOn(FLOOR, '2026-11-06').centavos()).toBe(5000n);
    expect(book.valueOn(PERCENT, '2026-11-06').basisPoints()).toBe(1000n);
    expect(book.valueOn(LOAN, '2026-11-06').centavos()).toBe(1n);
    expect(book.valueOn(WITHHOLDING, '2026-11-06').basisPoints()).toBe(50n);
    expect(book.valueOn(VAT, '2026-11-06').basisPoints()).toBe(1200n);
  });

  it('the answer names its key and unit, and its text is the default number', () => {
    const v = buildRuleBook([]).valueOn(FLOOR, '2026-11-06');
    expect(v.key).toBe(FLOOR);
    expect(v.unit).toBe('money');
    expect(num(v.text)).toBe(Number(RULE_REGISTRY[FLOOR].default));
    expect(buildRuleBook([]).valueOn(VAT, '2026-11-06').unit).toBe('percent');
  });

  it('a key outside the registry is refused, not defaulted [kills: a typo that quietly reads nothing]', () => {
    expect(() => buildRuleBook([]).valueOn('settlement.nothing' as BusinessRuleKey, '2026-11-06')).toThrow();
  });
});

describe('T-512 rule book - which row is in force on a date', () => {
  it('the row with the latest effective_from on or before the date wins; the starting row covers the time before it [kills: oldest row wins; no fall-back to the earlier row]', () => {
    const book = buildRuleBook([row(FLOOR, '50.000000', '2000-01-01'), row(FLOOR, '80.000000', '2026-12-01'), row(FLOOR, '120.000000', '2027-03-01')]);
    expect(book.valueOn(FLOOR, '2026-11-30').centavos()).toBe(5000n);
    expect(book.valueOn(FLOOR, '2026-12-15').centavos()).toBe(8000n);
    expect(book.valueOn(FLOOR, '2027-03-01').centavos()).toBe(12000n);
    expect(book.valueOn(FLOOR, '2031-01-01').centavos()).toBe(12000n);
    expect(book.valueOn(FLOOR, '2001-05-05').centavos()).toBe(5000n);
  });

  it('the day a row starts is already its day, the day before is not [kills: < instead of <=]', () => {
    const book = buildRuleBook([row(FLOOR, '50.000000', '2000-01-01'), row(FLOOR, '80.000000', '2026-12-01')]);
    expect(book.valueOn(FLOOR, '2026-12-01').centavos()).toBe(8000n);
    expect(book.valueOn(FLOOR, '2026-11-30').centavos()).toBe(5000n);
  });

  it('a row that starts after the date is never used, even when it is the only row: the default stands [kills: reading a scheduled change early]', () => {
    const book = buildRuleBook([row(PERCENT, '25.000000', '2026-12-01')]);
    expect(book.valueOn(PERCENT, '2026-11-30').basisPoints()).toBe(1000n);
    expect(book.valueOn(PERCENT, '2026-12-01').basisPoints()).toBe(2500n);
  });

  it('the order the rows arrive in does not matter [kills: first-row-wins on unsorted input]', () => {
    const rows = [row(FLOOR, '50.000000', '2000-01-01'), row(FLOOR, '80.000000', '2026-12-01'), row(FLOOR, '90.000000', '2026-12-20')];
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const book = buildRuleBook(order.map((i) => rows[i]!));
      expect(book.valueOn(FLOOR, '2026-12-25').centavos(), order.join()).toBe(9000n);
      expect(book.valueOn(FLOOR, '2026-12-10').centavos(), order.join()).toBe(8000n);
    }
  });

  it('two rows from the same day: the one made later wins (a same-day correction) [kills: effective_from alone decides]', () => {
    const first = row(FLOOR, '80.000000', '2026-12-01', { at: '2026-11-06T01:00:00.000Z', id: 'ffffffff-0000-4000-8000-000000000001' });
    const second = row(FLOOR, '95.000000', '2026-12-01', { at: '2026-11-06T02:00:00.000Z', id: '00000000-0000-4000-8000-000000000002' });
    for (const rows of [[first, second], [second, first]]) {
      expect(buildRuleBook(rows).valueOn(FLOOR, '2026-12-01').centavos()).toBe(9500n);
    }
  });

  it('same day AND same instant: the greater id wins, and the answer is the same whichever order the rows come in [kills: an unstable tie]', () => {
    const a = row(FLOOR, '80.000000', '2026-12-01', { at: '2026-11-06T01:00:00.000Z', id: '00000000-0000-4000-8000-0000000000aa' });
    const b = row(FLOOR, '95.000000', '2026-12-01', { at: '2026-11-06T01:00:00.000Z', id: '00000000-0000-4000-8000-0000000000bb' });
    for (const rows of [[a, b], [b, a]]) {
      expect(buildRuleBook(rows).valueOn(FLOOR, '2026-12-05').centavos()).toBe(9500n);
    }
  });

  it('a later effective_from beats a later created_at (the date decides first) [kills: created_at as the main key]', () => {
    const early = row(FLOOR, '80.000000', '2026-12-01', { at: '2026-11-09T00:00:00.000Z' });
    const lateDay = row(FLOOR, '95.000000', '2026-12-10', { at: '2026-11-01T00:00:00.000Z' });
    expect(buildRuleBook([early, lateDay]).valueOn(FLOOR, '2026-12-12').centavos()).toBe(9500n);
    expect(buildRuleBook([early, lateDay]).valueOn(FLOOR, '2026-12-05').centavos()).toBe(8000n);
  });

  it('keys do not leak into each other: a floor row never answers for the percent [kills: a lookup that ignores the key]', () => {
    const book = buildRuleBook([row(FLOOR, '80.000000', '2000-01-01')]);
    expect(book.valueOn(PERCENT, '2026-11-06').basisPoints()).toBe(1000n);
    expect(book.valueOn(FLOOR, '2026-11-06').centavos()).toBe(8000n);
  });

  it('the book is a pure value: asking twice, in any order of dates, gives the same answers', () => {
    const book = buildRuleBook([row(FLOOR, '50.000000', '2000-01-01'), row(FLOOR, '80.000000', '2026-12-01')]);
    const a = [book.valueOn(FLOOR, '2026-12-02').centavos(), book.valueOn(FLOOR, '2026-11-02').centavos(), book.valueOn(FLOOR, '2026-12-02').centavos()];
    expect(a).toEqual([8000n, 5000n, 8000n]);
  });
});

describe('T-512 rule book - exact conversions', () => {
  it('money to centavos, percent to basis points (percent x 100), for the stored numeric(18,6) text [kills: float multiplication; a wrong power of ten]', () => {
    const book = buildRuleBook([
      row(FLOOR, '99999.990000', '2000-01-01'),
      row(LOAN, '0.010000', '2000-01-01'),
      row(PERCENT, '10.000000', '2000-01-01'),
      row(WITHHOLDING, '0.500000', '2000-01-01'),
      row(VAT, '12.000000', '2000-01-01'),
    ]);
    expect(book.valueOn(FLOOR, '2026-11-06').centavos()).toBe(9999999n);
    expect(book.valueOn(LOAN, '2026-11-06').centavos()).toBe(1n);
    expect(book.valueOn(PERCENT, '2026-11-06').basisPoints()).toBe(1000n);
    expect(book.valueOn(WITHHOLDING, '2026-11-06').basisPoints()).toBe(50n);
    expect(book.valueOn(VAT, '2026-11-06').basisPoints()).toBe(1200n);
  });

  it('values that float arithmetic gets wrong stay exact: 0.07 and 0.29 money, 0.07 and 4.35 percent [kills: Number() on the way]', () => {
    const book = buildRuleBook([row(FLOOR, '0.290000', '2000-01-01'), row(LOAN, '0.070000', '2000-01-01'), row(PERCENT, '4.350000', '2000-01-01'), row(WITHHOLDING, '0.070000', '2000-01-01')]);
    expect(book.valueOn(FLOOR, '2026-11-06').centavos()).toBe(29n);
    expect(book.valueOn(LOAN, '2026-11-06').centavos()).toBe(7n);
    expect(book.valueOn(PERCENT, '2026-11-06').basisPoints()).toBe(435n);
    expect(book.valueOn(WITHHOLDING, '2026-11-06').basisPoints()).toBe(7n);
  });

  it('zero is a legal value and converts to 0n [kills: 0 read as "absent" and replaced by the default]', () => {
    const book = buildRuleBook([row(LOAN, '0.000000', '2000-01-01'), row(VAT, '0.000000', '2000-01-01')]);
    expect(book.valueOn(LOAN, '2026-11-06').centavos()).toBe(0n);
    expect(book.valueOn(VAT, '2026-11-06').basisPoints()).toBe(0n);
  });

  it('the wrong accessor throws: centavos() on a percent, basisPoints() on money [kills: a percent used as money]', () => {
    const book = buildRuleBook([]);
    expect(() => book.valueOn(PERCENT, '2026-11-06').centavos()).toThrow();
    expect(() => book.valueOn(VAT, '2026-11-06').centavos()).toThrow();
    expect(() => book.valueOn(FLOOR, '2026-11-06').basisPoints()).toThrow();
    expect(() => book.valueOn(LOAN, '2026-11-06').basisPoints()).toThrow();
  });

  it('a stored figure finer than a centavo (or a basis point) is refused, never rounded [kills: silent rounding]', () => {
    const book = buildRuleBook([row(FLOOR, '50.005000', '2000-01-01'), row(PERCENT, '10.005000', '2000-01-01')]);
    expect(() => book.valueOn(FLOOR, '2026-11-06').centavos()).toThrow();
    expect(() => book.valueOn(PERCENT, '2026-11-06').basisPoints()).toThrow();
  });
});
