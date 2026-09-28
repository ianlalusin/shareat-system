/**
 * T-353 S2 (DEF-484 follow-up), K1 — `docs/tasks/353-def-484-money-lines-errors-before-input.md`
 * §S2. The 2026-09-29 review found that deleting all 7 `markTouched` call sites, the four `onBlur`
 * handlers and the `invalid` capture listener in `MoneyLines.tsx` left 17/17 tests green — the repo
 * has no DOM test library (no jsdom/happy-dom/testing-library) and this slice adds none, so nothing
 * ever exercises the actual event wiring. This is a STATIC SOURCE guard, same idiom as
 * `action-link-sweep.test.ts`: it reads `MoneyLines.tsx` as TEXT and asserts the wiring is present in
 * the source, never by rendering or interacting with the component.
 *
 * What it checks:
 *   - every line control (method select, source select, staff select, amount input) carries a
 *     `markTouched` call for its OWN field(s), both on change (selects only — a pick is a finished
 *     answer) and on blur;
 *   - the enclosing-form `submit` listener and the capture-phase `invalid` listener are both
 *     registered (R4 — `invalid` does not bubble, and native `required` blocks `submit` from firing
 *     on a fresh form with empty Category/Particulars).
 *
 * ⛔ Per the tester's brief, the source was NOT edited to verify this reds under the mutant described
 * above. The reasoning instead: every assertion below matches an exact, byte-specific substring (the
 * call's full argument list, e.g. `markTouched(i, ['amount'])`, or the exact `addEventListener` call).
 * Deleting any ONE of the 7 `markTouched` call sites, or either `onBlur` prop, or either
 * `addEventListener` line removes that exact substring from the file with nothing else able to
 * reproduce it — `grep -c` of each pattern against the CURRENT source (recorded next to each
 * assertion below) shows every pattern matches EXACTLY the expected count today, so any deletion
 * changes that count and reds the test. A duplicate-but-differently-worded call (e.g. reordering the
 * array `['cashRequestId', 'moneyAccountId']`) would also red, which is intentional: the guard pins
 * the exact field lists R2-R3 name, not just "some call happened".
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const moneyLinesPath = resolve(here, '..', 'src', 'components', 'money', 'MoneyLines.tsx');
const source = readFileSync(moneyLinesPath, 'utf8');

function countOf(pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe('T-353 S2 / K1 — MoneyLines.tsx wiring guard (static source, no DOM)', () => {
  it('non-zero control: the file actually has substantial content to scan (a guard reading an empty/missing file must not report false green)', () => {
    expect(source.length).toBeGreaterThan(5000);
  });

  it('the method select marks "method" touched on BOTH change and blur — 2 call sites, exact count today', () => {
    // `markTouched(i, ['method']);` inside the onChange body, and the onBlur prop's arrow body.
    const calls = countOf(/markTouched\(i,\s*\[\s*'method'\s*\]\)/g);
    expect(calls, 'expected exactly the onChange + onBlur call sites for "method"').toBe(2);
    expect(source).toContain("onBlur={() => markTouched(i, ['method'])}");
  });

  it('the source select marks BOTH moneyAccountId and cashRequestId touched together, on change and blur — 2 call sites', () => {
    const calls = countOf(/markTouched\(i,\s*\[\s*'moneyAccountId',\s*'cashRequestId'\s*\]\)/g);
    expect(calls, 'expected exactly the onChange + onBlur call sites for the source select').toBe(2);
    expect(source).toContain("onBlur={() => markTouched(i, ['moneyAccountId', 'cashRequestId'])}");
  });

  it('the staff select marks "staffId" touched on both change and blur — 2 call sites', () => {
    const calls = countOf(/markTouched\(i,\s*\[\s*'staffId'\s*\]\)/g);
    expect(calls, 'expected exactly the onChange + onBlur call sites for "staffId"').toBe(2);
    expect(source).toContain("onBlur={() => markTouched(i, ['staffId'])}");
  });

  it('the amount input marks "amount" touched ONLY on blur — 1 call site (R2: onChange must not mark it, or "1." flashes an error mid-type)', () => {
    const calls = countOf(/markTouched\(i,\s*\[\s*'amount'\s*\]\)/g);
    expect(calls, 'expected exactly the single onBlur call site for "amount"').toBe(1);
    expect(source).toContain("onBlur={() => markTouched(i, ['amount'])}");
    // Guard the other half of R2: the amount input's onChange must be a bare `patch(...)`, i.e. the
    // one `markTouched(i, ['amount'])` occurrence found above must be the onBlur one, not also
    // reachable from onChange. If onChange ever grew a markTouched call, the total count assertion
    // in the whole-file test below (7) would also catch it.
    expect(source).toContain('onChange={(e) => patch(i, { amount: e.target.value })}');
  });

  it('exactly 7 markTouched(...) call sites total in the file — deleting any ONE of them reds this count', () => {
    // 2 (method) + 2 (source) + 2 (staff) + 1 (amount) = 7, per the review finding this guard exists
    // to pin: "Deleting all 7 markTouched call sites ... kept 17/17 green."
    const calls = countOf(/markTouched\(/g);
    expect(calls).toBe(7);
  });

  it('the enclosing-form "submit" listener is registered — R4', () => {
    expect(source).toContain("form.addEventListener('submit', onAttempt);");
  });

  it('the enclosing-form "invalid" listener is registered in the CAPTURE phase — R4 (invalid does not bubble)', () => {
    expect(source).toContain("form.addEventListener('invalid', onAttempt, true);");
  });

  it('both listeners are torn down in the effect cleanup, so a re-render never double-registers them', () => {
    expect(source).toContain("form.removeEventListener('submit', onAttempt);");
    expect(source).toContain("form.removeEventListener('invalid', onAttempt, true);");
  });
});
