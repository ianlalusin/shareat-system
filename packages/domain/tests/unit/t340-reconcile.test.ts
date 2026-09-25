import { describe, expect, it } from 'vitest';

/**
 * T-340 — docs/tasks/340-def-393-invoice-lines-nan-guard.md.
 *
 * `assertFiguresReconcile(label, stated, computed, tolerance)` is the ONE shared helper both
 * `trade/index.ts`'s `assertTradeTotalReconciles` and `items/index.ts`'s line/header checks
 * delegate to after this task. Contract (spec "Decision: one shared helper"):
 *   - `stated`, `computed` OR `tolerance` not `Number.isFinite` → throw
 *     `${label}: both figures must be finite — got stated=${stated}, computed=${computed}.`
 *     — a NaN tolerance is explicitly in scope (U4): `x > NaN` is always false, so skipping this
 *       check would silently reopen the hole the whole task exists to close.
 *   - else `Math.abs(stated - computed) > tolerance` → throw
 *     `${label}: ${stated} does not reconcile with ${computed} (beyond ${tolerance}).`
 *   - else returns void.
 *
 * ⛔ Accepted red today: the module does not exist yet (T-328 2(b) precedent) — this import fails
 * before the builder creates `packages/domain/src/shared/reconcile.ts`.
 *
 * ⛔ Every refusal below is matched against one of these two literals, never a bare `.toThrow()` —
 * a bare throw is satisfied by today's "is not a function" TypeError, which proves nothing about
 * the contract.
 */
import { assertFiguresReconcile } from '../../src/shared/reconcile';

const FINITE_MATCHER = /finite/i;
const MISMATCH_MATCHER = /does not reconcile/i;

describe('T-340 — assertFiguresReconcile: the one shared finiteness + tolerance guard', () => {
  it('U1: refuses a non-finite STATED figure', () => {
    expect(() => assertFiguresReconcile('L', NaN, 100, 0.01)).toThrow(FINITE_MATCHER);
  });

  it('U2: refuses a non-finite COMPUTED figure', () => {
    expect(() => assertFiguresReconcile('L', 100, NaN, 0.01)).toThrow(FINITE_MATCHER);
  });

  it('U3: refuses an infinite operand on either side — "finite" means finite, not merely "not NaN"', () => {
    expect(() => assertFiguresReconcile('L', Infinity, 100, 0.01)).toThrow(FINITE_MATCHER);
    expect(() => assertFiguresReconcile('L', 100, -Infinity, 0.01)).toThrow(FINITE_MATCHER);
  });

  it('U4: refuses a non-finite TOLERANCE — the silent case (x > NaN is always false)', () => {
    expect(() => assertFiguresReconcile('L', 5, 5, NaN)).toThrow(FINITE_MATCHER);
  });

  it('U5: a finite mismatch beyond tolerance is refused as a mismatch, not a finiteness failure', () => {
    expect(() => assertFiguresReconcile('L', 100, 200, 0.01)).toThrow(MISMATCH_MATCHER);
    expect(() => assertFiguresReconcile('L', 100, 200, 0.01)).not.toThrow(FINITE_MATCHER);
  });

  it('U6: the label is prefixed onto the message', () => {
    expect(() => assertFiguresReconcile('assertX', 1, 2, 0.01)).toThrow(/^assertX:/);
  });

  it('does not throw for finite figures within tolerance (including zero, and no exact-boundary case)', () => {
    expect(() => assertFiguresReconcile('L', 100, 100.004, 0.005)).not.toThrow();
    expect(() => assertFiguresReconcile('L', 0, 0, 0.01)).not.toThrow();
    expect(() => assertFiguresReconcile('L', 2900, 2900, 0.01)).not.toThrow();
  });
});
