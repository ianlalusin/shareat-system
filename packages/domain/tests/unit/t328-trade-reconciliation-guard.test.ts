import { describe, expect, it } from 'vitest';

/**
 * T-328 Test 2(b) — docs/tasks/328-every-typed-amount-reaches-the-parser-that-already-exists.md
 * §Tests item 2(b), per the orchestrator's ruling after Test 2(a)'s design question:
 * "THE RECONCILIATION BECOMES A PURE, EXPORTED, DIRECTLY-CALLABLE FUNCTION in
 * packages/domain/src/trade/, taking the two figures, refusing a non-finite operand explicitly.
 * The guard delegates to it."
 *
 * ⭐ WHY THIS IS A UNIT TEST, NOT AN INTEGRATION TEST: this function takes two numbers and
 * returns void or throws — no database, no transaction, no actor. Routing a reconciliation check
 * through Postgres to prove it rejects `NaN` would itself be the DEF-115 shape the briefing warned
 * about: the wrong layer standing in as the evidence for a different layer's behaviour.
 *
 * ⛔ WHY THIS TEST GOES RED FOR THE RIGHT REASON TODAY: `assertTradeTotalReconciles` does not
 * exist yet — `packages/domain/src/trade/index.ts` still has the reconciliation inline
 * (`Math.abs(Number(input.totalAmount) - total) > EPSILON`), never extracted, never exported. This
 * import fails. Per the orchestrator's explicit ruling (not my own default), that IS the intended
 * red here: this test defines the contract the builder implements against, the same way a
 * TDD spec test fails on a missing export before the export exists. It goes green the moment the
 * builder adds the export below with this shape; it is written so it then STAYS green through
 * Contract §4a landing too, unlike a test driven through `createTradeOrder`'s public input (Test
 * 2(a)), which the parser fix would make permanently unable to reach this code path at all.
 *
 * ⭐⭐ THE CONTRACT THIS TEST SPECIFIES, for the builder — pick this shape or an equivalent one and
 * update this comment if the real signature differs:
 *
 *   export function assertTradeTotalReconciles(stated: number, computed: number): void
 *
 *   - Throws when either `stated` or `computed` is not `Number.isFinite` — checked as ITS OWN
 *     condition, never inferred from `Math.abs(stated - computed) > EPSILON` (that comparison is
 *     `false` for a `NaN` operand — T-327 §P5's exact finding — so finiteness must be asked for
 *     directly, not derived). ⭐ THE MESSAGE MUST CONTAIN "finite" (case-insensitive) — this is
 *     the literal the tests below match on, chosen so this failure mode is textually
 *     distinguishable from the ordinary-mismatch one below, never merely "it threw something".
 *   - Throws when both are finite but `Math.abs(stated - computed) > EPSILON` — the ORIGINAL
 *     behaviour `createTradeOrder`'s inline guard already has today; extracting it must not lose
 *     it. `EPSILON` is `packages/domain/src/trade/index.ts`'s existing `0.005` (decimal noise
 *     only, never a business allowance — same file, same comment already there). ⭐ THE MESSAGE
 *     MUST CONTAIN "does not reconcile" (case-insensitive) — deliberately NOT sharing the word
 *     "finite" with the case above, so the two refusal reasons cannot be confused by a matcher.
 *   - Does not throw when both are finite and within EPSILON of each other.
 *   - `createTradeOrder` calls this in place of its inline comparison; Contract §4a's parsed
 *     `deliveryFee`/`otherFees`/`totalAmount` reads make a non-finite `stated`/`computed` pair
 *     unreachable through that caller specifically — which is exactly why this test does not
 *     drive through it, and instead hands the function a fabricated non-finite value directly.
 *
 * ⛔⛔ WHY EVERY "SHOULD THROW" ASSERTION BELOW NOW CARRIES A MATCHER, NOT BARE `.toThrow()` —
 * orchestrator's correction after the auditor measured this file red (1 failed / 4 passed) and
 * found the remaining weakness: a bare `.toThrow()` is satisfied by ANY throw, including TODAY's
 * `TypeError: assertTradeTotalReconciles is not a function` — refusal that comes free from the
 * missing export, not from the contract. Spec's own rule, one level over: "asserting refusal
 * alone is not enough... after T-327 refusal comes free from the constraint and proves nothing
 * about this task." A matcher chosen from THIS FILE'S OWN CONTRACT (never from today's TypeError
 * text) makes all five sub-tests red today for the SAME reason, and green only on genuine,
 * correctly-worded refusal — so a later rename or barrel breakage can't silently revert
 * sub-tests 1-4 to passing-on-TypeError while only sub-test 5 notices.
 */
import { assertTradeTotalReconciles } from '@shareat/domain';

/** The two literals the contract above specifies — never read from the TypeError text. */
const FINITE_MATCHER = /finite/i;
const MISMATCH_MATCHER = /does not reconcile/i;

describe('T-328 Test 2(b) — the trade reconciliation guard refuses a non-finite operand directly', () => {
  it('refuses when the STATED total is not finite, even though the magnitude comparison alone would not', () => {
    // What would have to be wrong for this to go red: assertTradeTotalReconciles must not throw
    // a message containing "finite" on this call. Today it cannot be called at all — the missing
    // export throws "is not a function", which does NOT match /finite/i, so this is red for the
    // same reason as every other sub-test in this file, not merely "something was thrown".
    expect(() => assertTradeTotalReconciles(NaN, 100)).toThrow(FINITE_MATCHER);
  });

  it('refuses when the COMPUTED total is not finite', () => {
    expect(() => assertTradeTotalReconciles(100, NaN)).toThrow(FINITE_MATCHER);
  });

  it('refuses an infinite operand the same way — "finite" means finite, not merely "not NaN"', () => {
    expect(() => assertTradeTotalReconciles(Infinity, 100)).toThrow(FINITE_MATCHER);
    expect(() => assertTradeTotalReconciles(100, -Infinity)).toThrow(FINITE_MATCHER);
  });

  it('still refuses an ordinary finite mismatch — the extraction must not lose the original check', () => {
    // Regression coverage for the behaviour that already exists inline today. If a future edit
    // to the extracted function keeps the finiteness check but drops the magnitude comparison,
    // this is the test that goes red for it. Matched on MISMATCH_MATCHER, not FINITE_MATCHER —
    // both operands here are finite, so a message containing "finite" would be the wrong reason.
    expect(() => assertTradeTotalReconciles(100, 200)).toThrow(MISMATCH_MATCHER);
  });

  it('does not throw when both are finite and reconcile within EPSILON', () => {
    expect(() => assertTradeTotalReconciles(100, 100)).not.toThrow();
    expect(() => assertTradeTotalReconciles(100, 100.004)).not.toThrow();
  });
});
