/**
 * Unit conversion — T-176 §4, §8 invariant 4, §10.6 (DEF-093). THE SINGLE COPY.
 *
 * ⭐ v1 has two of these — `recipe-units.ts` and a duplicate table inside
 * `production-recipe.actions.ts` — and its own comment names the duplicate dead code walking
 * (§4). Worse: `production-recipe.actions.ts`'s cook path calls its copy as
 * `resolveUnitConversion(line.unit, line.unit)` — an IDENTITY call that can never convert and
 * never fails, so a "500 g" recipe line against a kg-tracked item silently deducts 500 KILOS.
 * Logged as **DEF-093**. This module is what closes it: ONE table, and a HARD block — never a
 * pass-through — when a pairing is not convertible.
 *
 * ⭐ **Covers g<->kg and ml<->ltr only.** Everything else — `pcs<->pack`, `pcs<->box`, `kg<->ltr`
 * — returns `null` and the caller MUST block. v1's own reason: those pairings need a per-item
 * factor (unitsPerPack, density) that lives on the PRODUCT, not a global table — guessing one
 * here would deduct the wrong quantity forever.
 *
 * ⚠️ A blank unit on either side is NOT an implicit match — treating blank as "same" would let a
 * unitless recipe line deduct against any item at all.
 */
import { fromThousandths, toThousandths, type Quantity } from '../stock/quantity';

/** The base units this module knows how to convert between. Purchase-only containers (box, pack,
 *  case, sack, tray, dozen) are deliberately absent — see this file's header. */
export const CONVERTIBLE_UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'roll'] as const;
export type ConvertibleUnit = (typeof CONVERTIBLE_UNITS)[number];

/** Half-up on the absolute value — same rounding convention as `stock/layers.ts`'s
 *  `divideRoundHalfUp`, duplicated locally (it is a generic rounding primitive, not the
 *  conversion TABLE §4 forbids a second copy of). */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function scale(value: Quantity, numerator: bigint, denominator: bigint): Quantity {
  const thousandths = toThousandths(value);
  const scaled = thousandths * numerator;
  return fromThousandths(divideRoundHalfUp(scaled, denominator));
}

/**
 * Converts `value` from `fromUnit` to `toUnit`. Returns `null` when the pairing is not one this
 * module knows how to convert — the caller MUST treat `null` as a HARD block, never as "assume
 * it's fine" (DEF-093's exact failure mode).
 *
 * ⚠️ Rounds half-up to 3dp on the TARGET side when the exact value cannot be represented there
 * (e.g. converting a sub-milligram quantity of grams into kilos) — the same "round once, at the
 * end" discipline `stock/layers.ts`'s `lineCost` uses, never an intermediate rounding.
 */
export function convertUnit(value: Quantity, fromUnit: string, toUnit: string): Quantity | null {
  const from = fromUnit.trim();
  const to = toUnit.trim();
  // ⛔ Blank is never an implicit match (§10.6) — a unitless recipe line must not silently pass.
  if (!from || !to) return null;
  if (from === to) return value;
  if (from === 'g' && to === 'kg') return scale(value, 1n, 1000n);
  if (from === 'kg' && to === 'g') return scale(value, 1000n, 1n);
  if (from === 'ml' && to === 'ltr') return scale(value, 1n, 1000n);
  if (from === 'ltr' && to === 'ml') return scale(value, 1000n, 1n);
  // Every other pairing — pcs<->pack, pcs<->box, kg<->ltr, roll<->anything, and any unrecognised
  // string — needs a per-item factor this module deliberately does not guess at.
  return null;
}

/** Whether `unit` is a recognised base unit at all — used to give a readable refusal rather than
 *  a bare `null` from `convertUnit` when the input itself is not even a known unit. */
export function isConvertibleUnit(unit: string): unit is ConvertibleUnit {
  return (CONVERTIBLE_UNITS as readonly string[]).includes(unit.trim());
}
