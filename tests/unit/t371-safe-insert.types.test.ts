import { describe, expect, it } from 'vitest';
import { decimal, money, type Decimal, type Money } from '@shareat/core/money';
import { moneyAccounts, stores, tradeOrderLines } from '../../packages/db/schema';
import type { SafeInsert, SafeUpdate } from '../../packages/db/src/repo/numeric-input';
import { exceedsMaxMagnitude, parseDecimalInput } from '../../packages/domain/src/shared/money-input';

/**
 * T-371 — the COMMITTED type test for `SafeInsert` / `SafeUpdate` (audit: S2/S3 rely on them, so their behaviour is pinned by the compiler, not by hope), plus direct
 * unit legs for `parseDecimalInput`'s blank modes and `exceedsMaxMagnitude`'s boundary. `docs/tasks/371-nan-sweep.md` §C2 / §C3.
 *
 * ⚠️ HOW THIS TEST WORKS. `tests/**` is in the root tsconfig, so `npx tsc --noEmit` type-checks this file: each `// @ts-expect-error` line below is a compile-time
 * ASSERTION that the next statement does NOT type-check. If `SafeInsert` is ever loosened (a plain string starts to compile), the expect-error becomes unused and
 * `tsc` fails with "Unused '@ts-expect-error' directive". The runtime `it` blocks only exist so vitest has something to report; the real checks are the compiler's.
 *
 * What is pinned: a plain string and a string LITERAL (`'20000.00'`) are rejected for a numeric column; `money()` / a `Decimal` are accepted; a defaulted column is
 * omittable; a nullable column accepts `null`, `undefined` and a `Decimal` but rejects a string and `string | null`; a bulk `SafeInsert<T>[]` row with a plain string is
 * rejected; `SafeUpdate` is a `Partial` (an empty object is fine) and narrows the same way. Not pinned HERE (the type carries no precision/scale, §C2): WHICH shape —
 * that is guard leg G1.
 */
type MoneyAccountLimit = Pick<SafeInsert<typeof moneyAccounts>, 'overdraftLimit'>;
type StoreCeiling = Pick<SafeInsert<typeof stores>, 'unremittedCeiling'>;
type LineQuantities = Pick<SafeInsert<typeof tradeOrderLines>, 'quantity'>[];

describe('SafeInsert / SafeUpdate (compile-time assertions; see the file header)', () => {
  it('a numeric column rejects a plain string and a string literal, and accepts money() / a Decimal', () => {
    const plain = '20000.00' as string;
    // @ts-expect-error a plain string cannot stand in for a numeric column
    const rejectedPlain: MoneyAccountLimit = { overdraftLimit: plain };
    // @ts-expect-error a string LITERAL is still a plain string — only decimal()/money() mint the brand
    const rejectedLiteral: MoneyAccountLimit = { overdraftLimit: '20000.00' };
    const accepted: MoneyAccountLimit = { overdraftLimit: money('20000.00') };
    const acceptedDecimal: MoneyAccountLimit = { overdraftLimit: decimal('20000.00', '14,2') };
    // the type says "branded", not WHICH brand (precision/scale are not in Drizzle's column type) — shape is G1's job, so this compiles:
    const shapeUnchecked: MoneyAccountLimit = { overdraftLimit: decimal('1.000', '14,3') as Decimal };
    expect([rejectedPlain, rejectedLiteral, accepted, acceptedDecimal, shapeUnchecked].length).toBe(5);
  });

  it('a defaulted / optional column is omittable', () => {
    const omitted: MoneyAccountLimit = {}; // overdraft_limit is NOT NULL DEFAULT '20000.00'
    expect(omitted).toEqual({});
  });

  it('a nullable column accepts null, undefined and a Decimal, and rejects a string and string | null', () => {
    const nullValue: StoreCeiling = { unremittedCeiling: null };
    const undef: StoreCeiling = { unremittedCeiling: undefined };
    const omitted: StoreCeiling = {};
    const branded: StoreCeiling = { unremittedCeiling: money('50000.00') };
    // @ts-expect-error a plain string is rejected on a nullable numeric column too
    const rejectedString: StoreCeiling = { unremittedCeiling: '50000.00' };
    const maybe = null as string | null;
    // @ts-expect-error `string | null` is not `Decimal | null` — the string half is still rejected
    const rejectedMaybe: StoreCeiling = { unremittedCeiling: maybe };
    expect([nullValue, undef, omitted, branded, rejectedString, rejectedMaybe].length).toBe(6);
  });

  it('a BULK write takes SafeInsert<T>[]: a row with a plain string is rejected, branded rows are accepted', () => {
    const good: LineQuantities = [{ quantity: decimal('5.000', '14,3') }, { quantity: decimal('1.000', '14,3') }];
    // @ts-expect-error one plain-string row in a bulk insert is rejected
    const bad: LineQuantities = [{ quantity: decimal('5.000', '14,3') }, { quantity: '1.000' }];
    expect([good, bad].length).toBe(2);
  });

  it('SafeUpdate is a Partial: {} is allowed, a branded set is allowed, a plain string is rejected', () => {
    const empty: SafeUpdate<typeof moneyAccounts> = {};
    const branded: SafeUpdate<typeof moneyAccounts> = { overdraftLimit: money('5000.00') };
    // @ts-expect-error a plain string is rejected in an update too
    const bad: SafeUpdate<typeof moneyAccounts> = { overdraftLimit: '5000.00' };
    expect([empty, branded, bad].length).toBe(3);
  });

  it('Money is Decimal<14,2>: a Money value satisfies the narrowed type with no cast', () => {
    const m: Money = money('1.00');
    const row: MoneyAccountLimit = { overdraftLimit: m };
    expect(row.overdraftLimit).toBe('1.00');
  });
});

describe('parseDecimalInput — blank modes (R6: a blank follows its column; "0" is never invented)', () => {
  const parse = <M extends 'refuse' | 'omit' | 'null'>(raw: string | null | undefined, blank: M) =>
    parseDecimalInput(raw, '14,2', 'test: the amount', 'The amount', { blank } as never) as unknown;
  const BLANKS = ['', '   ', null, undefined] as const;

  it("'refuse': every blank (empty, spaces, null, undefined) throws a presentable sentence — never a value", () => {
    for (const raw of BLANKS) {
      let err: { message?: string; userMessage?: string } | null = null;
      try {
        parse(raw, 'refuse');
      } catch (e) {
        err = e as typeof err;
      }
      expect(err, `${JSON.stringify(raw)} was not refused`).not.toBeNull();
      expect(err!.userMessage, 'the sentence names the field and says blank').toBe("The amount — can't be left blank. Enter an amount.");
      expect(err!.message).toContain('left blank');
    }
  });

  it("'omit': every blank returns undefined (the database default applies / the column is left unchanged) — not '0.00'", () => {
    for (const raw of BLANKS) expect(parse(raw, 'omit'), JSON.stringify(raw)).toBeUndefined();
  });

  it("'null': every blank returns null (a nullable column stores null) — not '0.00'", () => {
    for (const raw of BLANKS) expect(parse(raw, 'null'), JSON.stringify(raw)).toBeNull();
  });

  it("a typed zero is a VALUE in every mode ('0' -> '0.00'); only a BLANK is special, so '0' is never invented and never swallowed", () => {
    for (const blank of ['refuse', 'omit', 'null'] as const) {
      expect(parse('0', blank), `blank:${blank} '0'`).toBe('0.00');
      expect(parse(' 0 ', blank), `blank:${blank} ' 0 '`).toBe('0.00');
    }
  });

  it('garbage is still a sentence in every mode (a blank mode does not soften NaN)', () => {
    for (const blank of ['refuse', 'omit', 'null'] as const) {
      for (const bad of ['abc', 'NaN']) {
        let userMessage: string | undefined;
        try {
          parse(bad, blank);
        } catch (e) {
          userMessage = (e as { userMessage?: string }).userMessage;
        }
        expect(userMessage, `blank:${blank} ${bad}`).toContain(`"${bad}"`);
      }
    }
  });

  it('without a mode (the existing call shape) a blank is NOT special: it is refused as malformed, exactly as before', () => {
    let userMessage: string | undefined;
    try {
      parseDecimalInput('', '14,2', 'test: the amount', 'The amount');
    } catch (e) {
      userMessage = (e as { userMessage?: string }).userMessage;
    }
    expect(userMessage).toContain('"" is not a valid');
  });
});

describe('exceedsMaxMagnitude — the exact (BigInt) ceiling decision, at the boundary', () => {
  it('(14,2): the largest value fits, one step more exceeds', () => {
    expect(exceedsMaxMagnitude('9.9999999999999e11', 14, 2), '999999999999.99 fits').toBe(false);
    expect(exceedsMaxMagnitude('1e12', 14, 2), '1,000,000,000,000.00 exceeds').toBe(true);
    expect(exceedsMaxMagnitude('9.99999999999999e11', 14, 2), '999999999999.999 rounds past the column').toBe(true);
  });

  it('(14,3): 11 integer digits', () => {
    expect(exceedsMaxMagnitude('9.9999999999999e10', 14, 3), '99999999999.999 fits').toBe(false);
    expect(exceedsMaxMagnitude('1e11', 14, 3)).toBe(true);
  });

  it('(14,0): a whole-number shape', () => {
    expect(exceedsMaxMagnitude('9.9999999999999e13', 14, 0)).toBe(false);
    expect(exceedsMaxMagnitude('1e14', 14, 0)).toBe(true);
  });

  it('zero in any exponent, a tiny value, a plain (non-exponent) string and non-numbers never "exceed"', () => {
    expect(exceedsMaxMagnitude('0e999', 14, 2)).toBe(false);
    expect(exceedsMaxMagnitude('1e-5', 14, 2)).toBe(false);
    expect(exceedsMaxMagnitude('1e-5000', 14, 2)).toBe(false);
    expect(exceedsMaxMagnitude('123456789012345678', 14, 2), 'only exponent notation is judged here').toBe(false);
    expect(exceedsMaxMagnitude('abc', 14, 2)).toBe(false);
    expect(exceedsMaxMagnitude('', 14, 2)).toBe(false);
  });

  it('an astronomically large exponent exceeds, with no float arithmetic and no hang', () => {
    expect(exceedsMaxMagnitude('1e5000', 14, 2)).toBe(true);
    expect(exceedsMaxMagnitude('-1e5000', 14, 2), 'a negative of the same magnitude exceeds too').toBe(true);
  });
});
