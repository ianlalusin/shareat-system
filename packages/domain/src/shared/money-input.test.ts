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
    expect(() => parseMoneyInput('0.004', 'createCashRequest: the amount')).toThrow(
      /createCashRequest: the amount.*"0\.004"/,
    );
    // ⚠️ Not the developer-facing message money() itself throws.
    expect(() => parseMoneyInput('0.004', 'x')).not.toThrow(/expected up to/);
  });

  it('refuses a value with more than two decimal places (the "1.234" case)', () => {
    expect(() => parseMoneyInput('1.234', 'x')).toThrow(/"1\.234"/);
  });

  it('refuses other unparseable strings the same way — empty, NaN-shaped, exponential', () => {
    for (const bad of ['', 'abc', '1e-7', '.004', 'NaN']) {
      expect(() => parseMoneyInput(bad, 'x')).toThrow();
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
    expect(() => parseMoneyInput('0.005', 'x')).toThrow(/"0\.005"/);
  });

  it('accepts ordinary exact amounts unchanged in value', () => {
    expect(parseMoneyInput('0.01', 'x')).toBe('0.01');
    expect(parseMoneyInput('12.50', 'x')).toBe('12.50');
    expect(parseMoneyInput('0', 'x')).toBe('0.00');
  });

  it('every message names the label, so a person can tell which field is wrong', () => {
    expect(() => parseMoneyInput('1.234', 'disburseLoan: the amount')).toThrow(
      /disburseLoan: the amount/,
    );
  });
});
