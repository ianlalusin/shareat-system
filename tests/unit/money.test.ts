import { describe, it, expect } from 'vitest';
import {
  money,
  add,
  subtract,
  multiply,
  allocate,
  negate,
  isZero,
  equals,
  compare,
  toCentavos,
  fromCentavos,
  ZERO,
  moneyFromLegacyFloat,
} from '@shareat/core/money';

describe('money — the float trap', () => {
  // PROJECT_BIBLE.md §12 landmine 25. In v1 every peso was a JS float, and drift was
  // fought by rounding at every incremental write. These are the cases that breaks.
  it('adds 0.1 + 0.2 to exactly 0.30', () => {
    expect(add(money('0.10'), money('0.20'))).toBe('0.30');
    // proof the naive approach is wrong:
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('does not accumulate error over many additions', () => {
    const cents = Array.from({ length: 1000 }, () => money('0.01'));
    expect(add(...cents)).toBe('10.00');
  });

  it('keeps precision on large amounts', () => {
    expect(add(money('999999999.99'), money('0.01'))).toBe('1000000000.00');
  });

  it('rejects a float that cannot be represented exactly to 2dp', () => {
    expect(() => money(0.1 + 0.2)).not.toThrow(); // 0.30000000000000004 rounds cleanly

    // 1.005 is NOT 1.005 in binary floating point — it is 1.00499999999999989.
    // Silently accepting it would store 1.00 while the caller believed they wrote 1.01.
    // Throwing is the honest answer; this is the exact trap this module exists to catch.
    expect(() => money(1.005)).toThrow(/lost precision/);
    expect(() => money(1 / 3)).toThrow(/lost precision/);
  });

  it('offers ETL an explicit, auditable escape hatch for legacy floats', () => {
    // v1 stored every peso as a float, so historical values WILL be unrepresentable.
    // The ETL must not be blocked — but the rounding has to be deliberate and reported,
    // never silent. See PROJECT_BIBLE.md §11 rule 5.
    const clean = moneyFromLegacyFloat(12.34);
    expect(clean).toEqual({ value: '12.34', rounded: false });

    // An exact .5 in centavos rounds away from zero, and is flagged.
    expect(moneyFromLegacyFloat(0.125)).toEqual({ value: '0.13', rounded: true });
    expect(moneyFromLegacyFloat(-0.125)).toEqual({ value: '-0.13', rounded: true });

    // 1.005 is really 1.00499999999999989, so it rounds DOWN to 1.00 — not up.
    // That is the same figure v1 produced, so migrated books reproduce v1 exactly...
    // but `rounded: true` records that the source value was ambiguous, which is the
    // whole point: reproduce the number, surface the doubt.
    const ambiguous = moneyFromLegacyFloat(1.005);
    expect(ambiguous.value).toBe('1.00');
    expect(ambiguous.rounded).toBe(true); // ← the flag the ETL logs and reconciles on
  });

  it('rejects malformed strings rather than coercing', () => {
    expect(() => money('12.345')).toThrow();
    expect(() => money('abc')).toThrow();
    expect(() => money('')).toThrow();
    expect(() => money('1,234.00')).toThrow();
  });
});

describe('money — zero is a value, not "unset"', () => {
  // §12 landmine 8: v1 discarded a 100% discount because a rate of 0 was falsy.
  it('treats 0 as a real amount', () => {
    expect(isZero(ZERO)).toBe(true);
    expect(equals(money('0'), money('0.00'))).toBe(true);
    expect(add(money('0'), money('5.00'))).toBe('5.00');
  });

  it('normalises representations of zero', () => {
    expect(money('0')).toBe('0.00');
    expect(money('-0.00')).toBe('0.00');
    expect(money(0)).toBe('0.00');
  });
});

describe('money — arithmetic', () => {
  it('subtracts, including into negatives', () => {
    expect(subtract(money('10.00'), money('3.25'))).toBe('6.75');
    expect(subtract(money('3.00'), money('10.00'))).toBe('-7.00');
  });

  it('negates symmetrically', () => {
    expect(negate(money('12.34'))).toBe('-12.34');
    expect(negate(money('-12.34'))).toBe('12.34');
    expect(negate(ZERO)).toBe('0.00');
  });

  it('round-trips through centavos', () => {
    for (const v of ['0.00', '0.01', '-0.01', '1234.56', '-9999.99']) {
      expect(fromCentavos(toCentavos(money(v)))).toBe(v === '-0.00' ? '0.00' : v);
    }
  });

  it('compares correctly', () => {
    expect(compare(money('1.00'), money('2.00'))).toBe(-1);
    expect(compare(money('2.00'), money('1.00'))).toBe(1);
    expect(compare(money('2.00'), money('2.000'.slice(0, 4)))).toBe(0);
  });
});

describe('money — multiply rounds half-up, once', () => {
  it('applies 12% VAT', () => {
    expect(multiply(money('100.00'), '0.12')).toBe('12.00');
    expect(multiply(money('1234.56'), '0.12')).toBe('148.15');
  });

  it('rounds half away from zero', () => {
    expect(multiply(money('0.05'), '0.5')).toBe('0.03'); // 0.025 -> 0.03
    expect(multiply(money('-0.05'), '0.5')).toBe('-0.03');
  });

  it('handles a rate of zero and a rate of one', () => {
    expect(multiply(money('123.45'), 0)).toBe('0.00');
    expect(multiply(money('123.45'), 1)).toBe('123.45');
  });

  it('rejects a malformed rate', () => {
    expect(() => multiply(money('1.00'), 'half')).toThrow();
  });
});

describe('money — allocate never loses or invents a centavo', () => {
  // The classic penny-allocation problem. A split that does not sum back exactly is how
  // subledgers stop tying to their control account.
  it('splits evenly when it divides cleanly', () => {
    expect(allocate(money('9.00'), 3)).toEqual(['3.00', '3.00', '3.00']);
  });

  it('distributes the remainder to the earliest parts', () => {
    expect(allocate(money('10.00'), 3)).toEqual(['3.34', '3.33', '3.33']);
  });

  it('always sums back to the original', () => {
    for (const [amount, parts] of [
      ['10.00', 3],
      ['0.01', 3],
      ['100.00', 7],
      ['-10.00', 3],
      ['0.05', 2],
    ] as const) {
      const shares = allocate(money(amount), parts);
      expect(shares).toHaveLength(parts);
      expect(add(...shares)).toBe(money(amount));
    }
  });

  it('rejects a nonsensical part count', () => {
    expect(() => allocate(money('1.00'), 0)).toThrow();
    expect(() => allocate(money('1.00'), 1.5)).toThrow();
  });
});

/**
 * T-343 S5.5n amendment — DEF-458. `MAX_ABS` (`packages/core/src/money.ts:26`) is
 * `10n ** 12n * FACTOR` = 10^14 centavos = exactly 1,000,000,000,000.00 pesos — a 13-digit integer
 * part. `numeric(14,2)` (bible §6) holds 14 total digits, 2 after the decimal, so its true integer
 * capacity is 12 digits: 999,999,999,999.99 is the largest value it can store, one centavo below
 * `MAX_ABS`. `fromCentavos`'s guard is `> MAX_ABS`, not `>=`, so `MAX_ABS` itself is currently
 * ACCEPTED — an off-by-one that lets `money()` mint a value the database it feeds cannot hold.
 */
describe('T-343 S5.5n — M1: the numeric(14,2) ceiling is 999,999,999,999.99, not 1,000,000,000,000.00', () => {
  it('1,000,000,000,000.00 (13 integer digits) is refused — red: accepted today', () => {
    expect(() => money('1000000000000.00')).toThrow(RangeError);
  });

  it('999,999,999,999.99 (12 integer digits, the true ceiling) is accepted — green now', () => {
    expect(money('999999999999.99')).toBe('999999999999.99');
  });

  // Orchestrator amendment — the guard is `Math.abs(centavos) > MAX_ABS` (`fromCentavos`), so the
  // off-by-one is symmetric: the negative side needs its own pair, not assumed from the positive one.
  it('-1,000,000,000,000.00 (13 integer digits, negative) is refused — red: accepted today', () => {
    expect(() => money('-1000000000000.00')).toThrow(RangeError);
  });

  it('-999,999,999,999.99 (12 integer digits, negative, the true ceiling) is accepted — green now', () => {
    expect(money('-999999999999.99')).toBe('-999999999999.99');
  });
});
