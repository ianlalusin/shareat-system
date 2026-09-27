import { describe, expect, it } from 'vitest';
import { parseMoneyInput } from './money-input';

/**
 * DEF-272 — the one place a raw money string becomes a validated `Money`. `money()` already
 * refuses a sub-centavo or over-precision string; the defect was every call site bypassing it
 * with a raw `Number(x) > 0` and letting the string through unparsed. This is the shared entry
 * point that closes the gap, and turns `money()`'s developer-facing throw into a written
 * sentence a cashier can act on.
 */
describe('parseMoneyInput', () => {
  it('refuses a sub-centavo amount with a written sentence, not a TypeError', () => {
    expect(() => parseMoneyInput('0.004', 'createCashRequest: the amount', 'The amount')).toThrow(
      /createCashRequest: the amount.*"0\.004"/,
    );
    // ⚠️ Not the developer-facing message money() itself throws.
    expect(() => parseMoneyInput('0.004', 'x', 'The amount')).not.toThrow(/expected up to/);
  });

  it('refuses a value with more than two decimal places (the "1.234" case)', () => {
    expect(() => parseMoneyInput('1.234', 'x', 'The amount')).toThrow(/"1\.234"/);
  });

  it('refuses other unparseable strings the same way — empty, NaN-shaped, exponential', () => {
    for (const bad of ['', 'abc', '1e-7', '.004', 'NaN']) {
      expect(() => parseMoneyInput(bad, 'x', 'The amount')).toThrow();
    }
  });

  // ⚠️ T-260's spec is internally inconsistent here — its own worked table shows CURRENT (buggy)
  // behavior accepting '0.005' (rounds to 0.01, no CHECK refuses it), but its "What DEF-272 got
  // wrong" section explicitly argues `money()` is the fix BECAUSE it is stricter than the database
  // and says so in so many words: "money('0.005') throws too, which is stricter than the database.
  // That is correct and intended." The "Done when" line "0.005 and 0.01 still work" reads like a
  // leftover from the narrower (rejected) remedy. Following the explicitly-argued design, not the
  // checklist line that contradicts it — reported to the orchestrator as a spec defect.
  it('0.005 is refused too — three decimal places into a two-decimal field, same as 1.234', () => {
    expect(() => parseMoneyInput('0.005', 'x', 'The amount')).toThrow(/"0\.005"/);
  });

  it('accepts ordinary exact amounts unchanged in value', () => {
    expect(parseMoneyInput('0.01', 'x', 'The amount')).toBe('0.01');
    expect(parseMoneyInput('12.50', 'x', 'The amount')).toBe('12.50');
    expect(parseMoneyInput('0', 'x', 'The amount')).toBe('0.00');
  });

  it('every message names the label, so a person can tell which field is wrong', () => {
    expect(() => parseMoneyInput('1.234', 'disburseLoan: the amount', 'The amount')).toThrow(
      /disburseLoan: the amount/,
    );
  });
});

/**
 * T-326 — DEF-379. This file's tests above import `./money-input` by relative path, which always
 * worked and proves nothing about the defect. `apps/erp`'s own consumer-side proof lives in
 * apps/erp/tests/money-input-resolves.test.ts; this is the second, independent proof the
 * ./money-lines precedent implies — that the package SUBPATH itself resolves (the exports-map +
 * vitest-alias half of the fix), separate from apps/erp's own tsconfig path resolving it.
 *
 * ⚠️ Dynamic import, not a static one — a static top-level import of an unresolved specifier
 * would fail this whole file, taking every test above down with it instead of isolating the one
 * new assertion that is actually expected to be red right now.
 */
describe('resolves via its own package subpath — DEF-379', () => {
  it('the module reachable at @shareat/domain/money-input is the same parseMoneyInput', async () => {
    const bySubpath = await import('@shareat/domain/money-input');
    expect(bySubpath.parseMoneyInput).toBe(parseMoneyInput);
  });
});
