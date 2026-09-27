/**
 * T-343 S5.5m — `parseMoneyInput`'s third argument, DEF-454.
 * docs/tasks/343-def-417-human-readable-refusals.md §S5.5m.
 *
 * ⛔ TESTER, not BUILDER. `humanLabel` is still optional on HEAD
 * (`packages/domain/src/shared/money-input.ts:34`).
 *
 * T1 (the compiler-enforced leg) was held out, commented, until S6c committed (orchestrator,
 * 2026-09-27 — a live `@ts-expect-error` red here would have shown up in `npm run typecheck` and
 * polluted S6c's own gate). S6c committed `f9cdeac`; T1 is live now. T1n and T2 were already true
 * before the builder (the three-argument contract already works) and are live, not red.
 */
import { describe, expect, it } from 'vitest';
import { parseMoneyInput } from '../src/shared/money-input';

// With `humanLabel` still optional, this directive is unused today (TS2578) — that IS this leg's
// own red. Once the builder makes the parameter required, the directive becomes used (an actual
// type error is suppressed) and the block goes green.
describe('T1 — humanLabel is required, proven at the type layer', () => {
  it('a two-argument call no longer typechecks; the runtime result is unaffected', () => {
    // @ts-expect-error S5.5m — humanLabel is required
    const result = parseMoneyInput('1', 'x');
    expect(result).toBe('1.00');
  });
});

describe('T1n (⛔ green now) — a three-argument call typechecks and behaves exactly as a two-argument one', () => {
  it('parseMoneyInput(raw, rawLabel, humanLabel) returns the parsed value', () => {
    expect(parseMoneyInput('1', 'x', 'The amount')).toBe('1.00');
  });
});

describe('T2 (⛔ green now) — the three-argument contract: raw .message unchanged, userMessage carries the human label', () => {
  it('a malformed amount: .message keeps the raw label, .userMessage uses the human one', () => {
    let caught: unknown;
    try {
      parseMoneyInput('abc', 'fn: the amount', 'The amount');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.message).toBe('fn: the amount — "abc" is not a valid amount. Use at most two decimal places.');
    expect(err.userMessage).toBe('The amount — "abc" is not a valid amount. Use at most two decimal places.');
  });

  it('the "1.234" (too many decimals) case also carries userMessage', () => {
    let caught: unknown;
    try {
      parseMoneyInput('1.234', 'x', 'The amount');
    } catch (err) {
      caught = err;
    }
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The amount — "1.234" is not a valid amount. Use at most two decimal places.');
  });
});
