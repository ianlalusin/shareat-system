/**
 * T-340 / DEF-393 — the one shared finiteness + tolerance guard.
 * `docs/tasks/340-def-393-invoice-lines-nan-guard.md`, "Decision: one shared helper".
 *
 * Both `trade/index.ts`'s `assertTradeTotalReconciles` and `items/index.ts`'s line/header checks
 * had the same shape twice over: two computed figures plus a tolerance, finiteness first, then
 * magnitude — only the tolerance (trade `0.005`, items `0.01`) and the label differed. Before
 * this task neither epsilon comparison guarded against a NaN or Infinity operand (`Math.abs(NaN
 * - x) > tolerance` is `false`), which is how DEF-393 slipped a non-numeric unit price past both
 * callers and left only the database's CHECK constraints to stop it.
 *
 * ⛔ Parses nothing, returns nothing, has no Money type — this is NOT a validator (T-328 §4b;
 * DEF-383 bars a second money parser). The caller already parsed/computed both figures; this only
 * compares them. ⛔ Not exported from `packages/domain/src/index.ts` — tests import by relative
 * path, exactly as `assertTradeTotalReconciles` was tested before this task.
 */
export function assertFiguresReconcile(label: string, stated: number, computed: number, tolerance: number): void {
  if (!Number.isFinite(stated) || !Number.isFinite(computed) || !Number.isFinite(tolerance)) {
    // A NaN tolerance makes `x > NaN` always false, which would silently reopen the hole this
    // function exists to close — so the tolerance is checked for finiteness too, not just the
    // two figures.
    throw new Error(`${label}: both figures must be finite — got stated=${stated}, computed=${computed}.`);
  }
  if (Math.abs(stated - computed) > tolerance) {
    throw new Error(`${label}: ${stated} does not reconcile with ${computed} (beyond ${tolerance}).`);
  }
}
