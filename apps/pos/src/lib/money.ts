/**
 * Round a numeric value to 2 decimal places (centavos / 2dp). Works for both
 * positive and negative values:
 *   roundMoney( 2978.349999) →  2978.35
 *   roundMoney(-2978.350001) → -2978.35
 *
 * Float math accumulates error (a value rendered "2978.35" can be 2978.34999…
 * or 2978.35000…1 internally), which makes strict comparisons reject equal
 * amounts and lets running sums drift. Run every money value — and any 2dp
 * quantity (counts, prices, kg) — through this at the boundary where it is
 * stored, compared, or aggregated.
 *
 * EPSILON nudges exact .xx5 cases to round half-up (e.g. 1.005 → 1.01).
 * Null/undefined → 0.
 */
export function roundMoney(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Alias for non-money 2dp quantities (counts, kg, prices) — same rounding. */
export const round2 = roundMoney;
