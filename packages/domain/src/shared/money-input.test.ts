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

  /**
   * T-343 S5.5n amendment (orchestrator) — DEF-458's "too large" arm must key on a genuinely
   * out-of-range VALUE, never on shallow text shape. None of these strings are too large: `1e-7`
   * is tiny, `1e+2`/`1e2`/`3.5e1` are 100, 100 and 35, and `note5` is not a number at all — it
   * merely contains the letter "e" immediately before a digit, the same shape the in-tree
   * `/e[+-]?\d/i` regex keys on. Every one of these must get the ordinary decimal-places sentence.
   * Red against the builder's current (over-broad) arm for every string carrying that shape.
   */
  it('refuses other unparseable strings with the decimal-places sentence, never "too large" — empty, NaN-shaped, exponential-shaped, garbage', () => {
    for (const bad of ['', 'abc', '1e-7', '.004', 'NaN', '1e+2', '1e2', '3.5e1', 'note5']) {
      expect(() => parseMoneyInput(bad, 'x', 'The amount'), `expected "${bad}" to be refused at all`).toThrow();
      let caught: unknown;
      try {
        parseMoneyInput(bad, 'x', 'The amount');
      } catch (err) {
        caught = err;
      }
      const userMessage = (caught as Error & { userMessage?: string }).userMessage;
      expect(userMessage, `"${bad}": expected the decimal-places sentence`).toContain('decimal places');
      expect(userMessage, `"${bad}": is not too large — it is malformed, not out of range`).not.toContain('too large');
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

/**
 * T-343 S5.5n — DEF-458. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5n item 2.
 *
 * ⛔ TESTER, not BUILDER. `money()`'s two distinct failures — a malformed STRING (`TypeError`) and
 * an out-of-range VALUE (`RangeError`, `packages/core/src/money.ts`'s `MAX_ABS`) — both land in
 * `parseMoneyInput`'s one bare `catch`, so an out-of-range amount gets the SAME "Use at most two
 * decimal places" sentence as a malformed one, which is wrong advice: no number of decimal places
 * fixes a value that is simply too big. Red until the builder branches on the caught error's
 * constructor and gives `RangeError` its own "too large" sentence, quoting `money.ts`'s own ceiling.
 */
describe('T-343 S5.5n — R1: an out-of-range amount gets its own "too large" sentence, not the decimal-places one', () => {
  it('R1: 14 nines (RangeError — out of range for numeric(14,2)) says "too large", not "decimal places"', () => {
    let caught: unknown;
    try {
      parseMoneyInput('99999999999999', 'x', 'The amount');
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected 14 nines to be refused at all').toBeInstanceOf(Error);
    const userMessage = (caught as Error & { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toContain('too large');
    expect(userMessage).not.toContain('decimal places');
  });

  it(
    'R1n (⛔ green now) — "1.234" (TypeError — too many decimal places) keeps today\'s sentence, byte-identical',
    () => {
      let caught: unknown;
      try {
        parseMoneyInput('1.234', 'x', 'The amount');
      } catch (err) {
        caught = err;
      }
      const err = caught as Error & { userMessage?: string };
      expect(err.userMessage).toBe('The amount — "1.234" is not a valid amount. Use at most two decimal places.');
    },
  );

  it('R2: "1e+21" says "too large", not "decimal places" (orchestrator amendment)', () => {
    let caught: unknown;
    try {
      parseMoneyInput('1e+21', 'x', "A line's total");
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1e+21" to be refused at all').toBeInstanceOf(Error);
    const userMessage = (caught as Error & { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toContain('too large');
    expect(userMessage).not.toContain('decimal places');
  });
});
