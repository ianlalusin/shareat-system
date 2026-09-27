import { describe, expect, it } from 'vitest';
import { quantity } from '../../src/stock/quantity';

/**
 * T-343 S5.5p — DEF-462. `packages/domain/src/stock/quantity.ts`'s `MAX_ABS` is
 * `10n ** 11n * FACTOR` = 10^14 thousandths = exactly 100,000,000,000.000 — a 12-integer-digit
 * value. `numeric(14,3)` (this file's own header comment, and the bible) holds 14 total digits, 3
 * after the decimal, so its true integer capacity is 11 digits: 99,999,999,999.999 is the largest
 * value it can store, one thousandth below `MAX_ABS`. `fromThousandths`'s guard is `> MAX_ABS`, not
 * `>=`, so `MAX_ABS` itself is currently ACCEPTED — the same off-by-one `tests/unit/money.test.ts`'s
 * M1 describes for `money()`, one axis over.
 *
 * ⛔ TESTER, not BUILDER. No pre-existing dedicated unit test for `quantity()` was found (searched
 * `**\/*quantity*.test.ts` and every `*.test.ts` importing `addQuantity`/`fromThousandths`/etc. —
 * every hit uses `quantity()` as a fixture helper inside a domain-integration file, never tests the
 * primitive itself) — created here, in `packages/domain/tests/unit/` beside this package's other
 * pure-logic unit tests (`fifo-rules.test.ts`, `variance-split.test.ts`), following
 * `tests/unit/money.test.ts`'s M1 structure since `quantity.ts`'s own header calls itself
 * "`packages/core/src/money.ts` applied to the other axis."
 */
describe('T-343 S5.5p — Q1: the numeric(14,3) ceiling is 99,999,999,999.999, not 100,000,000,000.000', () => {
  it('100,000,000,000.000 (12 integer digits) is refused — red: accepted today', () => {
    expect(() => quantity('100000000000')).toThrow(RangeError);
  });

  it('99,999,999,999.999 (11 integer digits, the true ceiling) is accepted — green now', () => {
    expect(quantity('99999999999.999')).toBe('99999999999.999');
  });

  it('-100,000,000,000.000 (12 integer digits, negative) is refused — red: accepted today', () => {
    expect(() => quantity('-100000000000')).toThrow(RangeError);
  });

  it('-99,999,999,999.999 (11 integer digits, negative, the true ceiling) is accepted — green now', () => {
    expect(quantity('-99999999999.999')).toBe('-99999999999.999');
  });
});
