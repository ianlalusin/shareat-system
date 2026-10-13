/**
 * Exact decimal arithmetic on scaled bigint, shared by every price rule that rounds (T-151 `computeBranchPrice`, T-401 online
 * rules). Never a float (RULES section 6). The ONE rounding rule: once, half-up on the absolute value, to the centavo, the
 * convention of `multiply` in `@shareat/core/money`. Extracted unchanged from `items/branch-price.ts` so there is no second one.
 */
export const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** `numerator / denominator` (denominator > 0), rounded half-up on the absolute value. */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const a = negative ? -numerator : numerator;
  const q = a / denominator;
  const rounded = (a % denominator) * 2n >= denominator ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** An integer count of `10^-places` units as text, never through a float. */
export function textOf(units: bigint, places: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const f = pow10(places);
  const frac = places > 0 ? `.${(abs % f).toString().padStart(places, '0')}` : '';
  return `${negative && abs !== 0n ? '-' : ''}${abs / f}${frac}`;
}
