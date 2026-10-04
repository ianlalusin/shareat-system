import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@shareat/core/money';
import { quantity } from '../../packages/domain/src/stock/quantity';
import { constrainedColumns, ROOT } from './lib/numeric-write-census';

/**
 * T-371 S0 — `decimal()` (C1), the ONE mint of a branded `Decimal<'p,s'>`. `docs/tasks/371-nan-sweep.md` §S0 `t371-decimal.test.ts`.
 *
 * ⛔ TESTER. RED UNTIL S1: `decimal` and `compareDecimal` do not exist in `@shareat/core/money` yet, so every leg fails on its own
 * assertion ("decimal is not exported") instead of the whole file failing at import. The nine shapes are DERIVED at runtime from the
 * Drizzle schema (never listed), so a new numeric shape appears here by itself.
 *
 * What it pins, per shape: it ACCEPTS `0`, the maximum, the negative maximum, exactly `scale` places, `"0.00"`/`"-0"`/`"-0.00"`
 * (all normalise to zero at `scale` places), surrounding whitespace and an exact finite number; it REFUSES the maximum plus one step,
 * `scale + 1` places, `NaN`, `Infinity`, `-Infinity`, `abc`, `''`, `' '`, `1e3` and a leading `+`. The leading-`+` refusal pins
 * TODAY'S `money()` behaviour (it refuses `+1`), so any change to it is visible. Equivalence: `decimal(x,'14,2')` answers exactly as
 * `money(x)` on every input literal in `tests/unit/money.test.ts`, and `decimal(x,'14,3')` as `quantity(x)` on the inputs in
 * `packages/domain/tests/unit/quantity.test.ts`.
 */
type DecimalFn = (value: string | number | bigint, shape: string) => string;
const decimal = (): DecimalFn => {
  const fn = (core as unknown as { decimal?: DecimalFn }).decimal;
  if (typeof fn !== 'function') throw new Error('decimal is not exported from @shareat/core/money (C1: the single mint of Decimal<p,s> does not exist yet)');
  return fn;
};

const shapes = [...new Set(constrainedColumns().map((c) => c.shape))].sort();

/** `scale` places, zero-padded: `'0.00'`, `'0.000'`, or `'0'` when scale is 0. */
const zero = (scale: number) => (scale > 0 ? `0.${'0'.repeat(scale)}` : '0');
const maxOf = (precision: number, scale: number) => `${'9'.repeat(precision - scale)}${scale > 0 ? `.${'9'.repeat(scale)}` : ''}`;
const onePast = (precision: number, scale: number) => `1${'0'.repeat(precision - scale)}${scale > 0 ? `.${'0'.repeat(scale)}` : ''}`;

describe('derived shapes', () => {
  it('floor: shapes were derived from the schema', () => {
    expect(shapes.length, 'no numeric shape was derived').toBeGreaterThan(0);
  });
});

describe.each(shapes)('decimal(…, "%s")', (shape) => {
  const [p, s] = shape.split(',').map(Number) as [number, number];

  it('ACCEPTS zero, the maximum, the negative maximum and exactly `scale` places, returning the value at exactly `scale` places', () => {
    const d = decimal();
    expect(d('0', shape)).toBe(zero(s));
    expect(d(maxOf(p, s), shape)).toBe(maxOf(p, s));
    expect(d(`-${maxOf(p, s)}`, shape)).toBe(`-${maxOf(p, s)}`);
    if (s > 0) expect(d(`1.${'1'.repeat(s)}`, shape)).toBe(`1.${'1'.repeat(s)}`);
  });

  it('ACCEPTS "0.00"-style zero, "-0" and "-0.00" (all normalise to zero at `scale` places), surrounding whitespace, and an exact finite number', () => {
    const d = decimal();
    expect(d(zero(s), shape)).toBe(zero(s));
    expect(d('-0', shape)).toBe(zero(s));
    expect(d(s > 0 ? `-0.${'0'.repeat(s)}` : '-0', shape)).toBe(zero(s));
    expect(d('  5  ', shape)).toBe(s > 0 ? `5.${'0'.repeat(s)}` : '5');
    expect(d(5, shape), 'an exact finite number takes money()\'s number path').toBe(s > 0 ? `5.${'0'.repeat(s)}` : '5');
  });

  it('REFUSES the maximum plus one step with a RangeError, and `scale + 1` places with a TypeError', () => {
    const d = decimal();
    expect(() => d(onePast(p, s), shape), 'the maximum plus one step').toThrow(RangeError);
    expect(() => d(`1.${'1'.repeat(s + 1)}`, shape), '`scale + 1` places').toThrow(TypeError);
  });

  it('REFUSES NaN, Infinity, -Infinity, abc, the empty string, a blank, an exponent and a leading + (a TypeError each)', () => {
    const d = decimal();
    for (const bad of ['NaN', 'Infinity', '-Infinity', 'abc', '', ' ', '1e3']) {
      expect(() => d(bad, shape), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => d(Number.NaN, shape), 'the number NaN').toThrow(TypeError);
    expect(() => d(Number.POSITIVE_INFINITY, shape), 'the number Infinity').toThrow(TypeError);
    // ⚠️ Pins TODAY's behaviour: `money()` refuses a leading `+`, so `decimal()`'s accepted set (✎R11) refuses it too. Any change is visible here.
    expect(() => d('+1', shape), 'a leading + (pins money()\'s present refusal)').toThrow(TypeError);
  });
});

describe('equivalence — decimal() answers exactly as the existing parsers do', () => {
  const outcome = (f: () => unknown): string => {
    try {
      return `ok:${String(f())}`;
    } catch (e) {
      return `throws:${(e as Error).constructor.name}`;
    }
  };
  const literalInputs = (file: string, call: string): (string | number)[] => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const re = new RegExp(`${call}\\(\\s*('([^'\\\\]|\\\\.)*'|"([^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?)\\s*\\)`, 'g');
    const out = new Set<string | number>();
    for (const m of text.matchAll(re)) {
      const lit = m[1]!;
      out.add(/^['"]/.test(lit) ? lit.slice(1, -1) : Number(lit));
    }
    return [...out];
  };

  it('floor: the equivalence inputs were extracted from money.test.ts and quantity.test.ts', () => {
    expect(literalInputs('tests/unit/money.test.ts', 'money').length, 'no money() inputs found').toBeGreaterThan(0);
    expect(literalInputs('packages/domain/tests/unit/quantity.test.ts', 'quantity').length, 'no quantity() inputs found').toBeGreaterThan(0);
  });

  it('money(x) and decimal(x, "14,2") agree on every input literal in tests/unit/money.test.ts', () => {
    const d = decimal();
    const diffs = literalInputs('tests/unit/money.test.ts', 'money')
      .map((x) => ({ x, was: outcome(() => core.money(x as never)), now: outcome(() => d(x as never, '14,2')) }))
      .filter((r) => r.was !== r.now)
      .map((r) => `${JSON.stringify(r.x)}: money() ${r.was} but decimal() ${r.now}`);
    expect(diffs).toEqual([]);
  });

  it('quantity(x) and decimal(x, "14,3") agree on every input literal in the quantity tests', () => {
    const d = decimal();
    const diffs = literalInputs('packages/domain/tests/unit/quantity.test.ts', 'quantity')
      .map((x) => ({ x, was: outcome(() => quantity(x as never)), now: outcome(() => d(x as never, '14,3')) }))
      .filter((r) => r.was !== r.now)
      .map((r) => `${JSON.stringify(r.x)}: quantity() ${r.was} but decimal() ${r.now}`);
    expect(diffs).toEqual([]);
  });

  it('compareDecimal exists and orders values in scaled bigint (C1)', () => {
    const cmp = (core as unknown as { compareDecimal?: (a: string, b: string) => number }).compareDecimal;
    if (typeof cmp !== 'function') throw new Error('compareDecimal is not exported from @shareat/core/money (C1 does not exist yet)');
    expect(cmp('1.10', '1.9')).toBeLessThan(0);
    expect(cmp('2.00', '2.00')).toBe(0);
    expect(cmp('-1.00', '-2.00')).toBeGreaterThan(0);
  });
});
