/**
 * T-423 S1 - the one money module (Ruling 1). Money inside the till is a whole number of centavos.
 * Firestore keeps v1's wire (peso numbers); `toWirePesos(centavos)` is the only way a peso number is made.
 * This file holds the ONE rounding implementation in apps/pos (DEF-003).
 */

import { Exact, ZERO } from './exact';

let nonCentavoCount = 0;

/** How many stored values since the last reset were not already a whole number of centavos. */
export function getNonCentavoCount(): number {
  return nonCentavoCount;
}

export function resetNonCentavoCount(): void {
  nonCentavoCount = 0;
}

/** Rounds to an integer, .5 goes up (away from zero for negatives, so a refund mirrors its sale). */
export function roundHalfUp(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return -roundHalfUp(-x);
  return Math.floor(x + 0.5);
}

/**
 * A peso number READ FROM FIRESTORE (catalog price, modifier, fixed discount, receipt) -> integer centavos.
 * Rounds half-up, never throws (junk -> 0), and counts values that were not already whole centavos so one bad
 * catalog value is visible but cannot stop checkout (row 67's legacy-float rule).
 */
export function storedPesosToCentavos(x: unknown): number {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  const scaled = n * 100;
  // toPrecision(12) removes binary float dust (1.005 * 100 = 100.49999999999999) so true half-centavos round up.
  const cleaned = Number(scaled.toPrecision(12));
  const c = roundHalfUp(cleaned);
  if (Math.abs(scaled - c) > 1e-6) {
    nonCentavoCount += 1;
    if (nonCentavoCount <= 20) console.warn(`[money] stored amount ${n} is not a whole number of centavos; rounded to ${c}`);
  }
  return c;
}

const TYPED_AMOUNT = /^(?:(\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/;

/** What a person typed -> integer centavos. Exact or refused with a plain message. */
export function parsePesoInput(s: string): number {
  const text = String(s ?? '').trim();
  const m = TYPED_AMOUNT.exec(text);
  if (!m) throw new Error(`"${text}" is not a valid amount. Use pesos and at most two decimals, for example 12.50.`);
  const whole = m[1] ?? '0';
  const frac = (m[2] ?? m[3] ?? '').padEnd(2, '0');
  const c = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(c)) throw new Error(`"${text}" is too large to be an amount.`);
  return c;
}

/** Largest-remainder split of an integer `total` by non-negative weights. Sums exactly; ties go to the earlier index. */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total)) throw new RangeError(`allocate: total must be an integer, got ${total}`);
  if (!Array.isArray(weights) || weights.length === 0) throw new RangeError('allocate: weights must not be empty');
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError('allocate: weights must be non-negative numbers');
  // Preserve the existing six-decimal numeric-weight contract.
  return allocateExact(total, weights.map(weight => new Exact(BigInt(Math.floor(weight * 1e6)))));
}

/** The same largest-remainder allocator, with exact fractional weights for line adjustments. */
export function allocateExact(total: number, weights: readonly Exact[]): number[] {
  if (!Number.isInteger(total)) throw new RangeError('allocate: total must be an integer');
  if (!weights.length || weights.some(weight => weight.d <= 0n || weight.n < 0n)) throw new RangeError('allocate: weights must be non-negative');
  const sum = weights.reduce((sum, weight) => sum.add(weight), ZERO);
  if (sum.isZero()) throw new RangeError('allocate: weights must not all be zero');
  if (total < 0) return allocateExact(-total, weights).map(value => value === 0 ? 0 : -value);
  const quotas = weights.map(weight => Exact.int(total).mul(weight).div(sum));
  const floors = quotas.map(quota => quota.n / quota.d);
  let left = total - Number(floors.reduce((sum, value) => sum + value, 0n));
  const order = quotas.map((quota, i) => ({ r: new Exact(quota.n % quota.d, quota.d), i }))
    .sort((a, b) => -a.r.cmp(b.r) || a.i - b.i);
  const out = floors.map((f) => Number(f));
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1; // Each index came from quotas, which has the same length as out.
    left -= 1;
  }
  return out;
}

/** Integer centavos -> the peso number v1's Firestore documents hold. */
export function toWirePesos(c: number): number {
  if (!Number.isInteger(c)) throw new RangeError(`toWirePesos: ${c} is not a whole number of centavos`);
  return c === 0 ? 0 : c / 100;
}

/** Old name for peso values read from Firestore (kept so existing imports keep working). */
export function roundMoney(value: number | null | undefined): number {
  return toWirePesos(storedPesosToCentavos(value));
}
