import { describe, expect, it } from 'vitest';
import { parseQuantityInput } from './quantity-input';

/**
 * T-351 (DEF-483) — `parseQuantityInput` crashes with a raw `TypeError` ("raw.trim is not a
 * function") for any non-string input, instead of the written sentence it exists to produce.
 * `quantity()` (`stock/quantity.ts`) itself accepts a `number` (exact to 3dp only) — a caller
 * that forwards one today gets a crash on line 27's `raw.trim()`, not a refusal.
 *
 * ⛔ TESTER, not BUILDER. Colocated like `money-input.test.ts`.
 */
describe('parseQuantityInput — a non-string raw value refuses in words, never crashes', () => {
  it('Q1: NaN — the decimal-places sentence, quoting "NaN" — was red today: TypeError (raw.trim is not a function)', () => {
    let caught: unknown;
    try {
      parseQuantityInput(NaN as unknown as string, 'raw', 'Human');
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected a refusal, not a crash').toBeInstanceOf(Error);
    expect((caught as Error).name, 'wanted: not a TypeError').not.toBe('TypeError');
    expect((caught as Error & { userMessage?: string }).userMessage).toBe(
      'Human — "NaN" is not a valid quantity. Use at most three decimal places.',
    );
  });

  it('Q2: 1.2345 (a precision-loss RangeError from quantity()) — the same decimal-places sentence, quoting "1.2345" — was red today: TypeError', () => {
    let caught: unknown;
    try {
      parseQuantityInput(1.2345 as unknown as string, 'raw', 'Human');
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected a refusal, not a crash').toBeInstanceOf(Error);
    expect((caught as Error).name, 'wanted: not a TypeError').not.toBe('TypeError');
    expect((caught as Error & { userMessage?: string }).userMessage).toBe(
      'Human — "1.2345" is not a valid quantity. Use at most three decimal places.',
    );
  });
});
