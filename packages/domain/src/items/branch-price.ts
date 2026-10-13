/**
 * The branch price rule, ported from v1's `computeBranchPrice`
 * (`ERP-rebuild/src/lib/financial/commissary/pricing.ts`). T-151.
 *
 * | Mode | Price |
 * |---|---|
 * | `fixed` | a set peso amount |
 * | `fixed_markup` | basis + peso amount |
 * | `percent_markup` | basis x (1 + markup%) |
 *
 * Pure on purpose: the basis is resolved by the caller (derived from landed invoice history), so
 * this is the arithmetic and nothing else, and it can be unit-tested without a database.
 *
 * ⭐ T-371 (DEF-382): exact, in scaled bigint — never a float (RULES §6). Each rule figure is minted through `decimal()`
 * at its `item_pricing` column's shape (`fixed_amount`/`fixed_markup_amount` (14,2), `markup_percent`/
 * `margin_alert_threshold_pct` (8,4)), so a malformed one is refused instead of becoming `NaN`. The basis is a derived
 * figure of any scale (a `numeric` division), read exactly as a fraction. Every output is rounded ONCE, half-up on the
 * absolute value — the convention of `multiply` in `@shareat/core/money` — and the margin alert compares the UNROUNDED
 * margin against the threshold by cross-multiplication.
 */
import { decimal } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { divideRoundHalfUp, pow10, textOf } from '../shared/exact-decimal';

export interface BranchPriceRule {
  pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
  fixedAmount?: string | null;
  markupPercent?: string | null;
  fixedMarkupAmount?: string | null;
  marginAlertThresholdPct?: string | null;
}

export interface BranchPrice {
  price: string;
  basis: string;
  /** Null when the basis is zero - never a divide by zero. */
  marginPct: string | null;
  /**
   * Advisory. It warns; it never blocks an order.
   * `percent_markup` never alerts: the margin equals the configured markup by construction.
   */
  marginAlert: boolean;
}

/** An exact decimal: `units / 10^scale`. */
interface Exact {
  units: bigint;
  scale: number;
}

/** A plain decimal string (a minted `Decimal`, or a `numeric::text` of any scale) as an exact fraction. */
function exactOf(value: string, what: string): Exact {
  const trimmed = value.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!m) {
    throw refuse(
      `computeBranchPrice: the ${what} ${JSON.stringify(value)} is not a plain decimal.`,
      `The branch price could not be worked out — the ${what} "${value}" is not a number.`,
    );
  }
  const frac = m[3] ?? '';
  const units = BigInt(`${m[2]}${frac}`);
  return { units: m[1] === '-' ? -units : units, scale: frac.length };
}

/** A rule figure, minted at its column's shape, as an exact fraction. */
function ruleFigure<S extends `${number},${number}`>(value: string | null | undefined, shape: S, what: string): Exact {
  let minted: string;
  try {
    minted = decimal(value ?? '0', shape);
  } catch {
    throw refuse(
      `computeBranchPrice: the ${what} ${JSON.stringify(value)} is not a valid numeric(${shape}).`,
      `The branch price could not be worked out — the ${what} "${value}" is not a valid number.`,
    );
  }
  return exactOf(minted, what);
}

/** Bring two exact values to one scale. */
function aligned(a: Exact, b: Exact): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return { a: a.units * pow10(scale - a.scale), b: b.units * pow10(scale - b.scale), scale };
}

export function computeBranchPrice(rule: BranchPriceRule, basis: string): BranchPrice {
  const b = exactOf(basis, 'cost basis');
  const basisText = textOf(divideRoundHalfUp(b.units * pow10(4), pow10(b.scale)), 4);
  // The threshold is a percent at (8,4): `thresholdUnits / 10^4`.
  const threshold =
    rule.marginAlertThresholdPct == null
      ? null
      : ruleFigure(rule.marginAlertThresholdPct, '8,4', 'margin alert threshold').units;
  const basisPositive = b.units > 0n;

  if (rule.pricingMode === 'fixed') {
    const price = ruleFigure(rule.fixedAmount, '14,2', 'fixed price');
    const { a: p, b: base } = aligned(price, b);
    // margin% = (price − basis) / basis × 100; in hundredths of a percent: (p − base) × 100 × 100 / base.
    const marginNumerator = (p - base) * 100n;
    return {
      price: textOf(price.units, 2),
      basis: basisText,
      marginPct: basisPositive ? textOf(divideRoundHalfUp(marginNumerator * 100n, base), 2) : null,
      // margin < threshold ⟺ (p − base) × 100 × 10^4 < threshold × base   (base > 0)
      marginAlert: threshold != null && basisPositive && marginNumerator * pow10(4) < threshold * base,
    };
  }

  if (rule.pricingMode === 'fixed_markup') {
    const markup = ruleFigure(rule.fixedMarkupAmount, '14,2', 'markup amount');
    const { a: m, b: base, scale } = aligned(markup, b);
    const marginNumerator = m * 100n;
    return {
      price: textOf(divideRoundHalfUp((base + m) * 100n, pow10(scale)), 2),
      basis: basisText,
      marginPct: basisPositive ? textOf(divideRoundHalfUp(marginNumerator * 100n, base), 2) : null,
      // The markup is fixed in pesos but the margin% shrinks as the basis grows, so the
      // threshold is useful here too - v1 alerts in this mode for exactly that reason.
      marginAlert: threshold != null && basisPositive && marginNumerator * pow10(4) < threshold * base,
    };
  }

  // markup% at (8,4): `markupUnits / 10^4`. price = basis × (100 + markup%) / 100
  //   = b.units × (100 × 10^4 + markupUnits) / (10^b.scale × 10^6), rounded to the centavo.
  const markupUnits = ruleFigure(rule.markupPercent, '8,4', 'markup percent').units;
  return {
    price: textOf(divideRoundHalfUp(b.units * (pow10(6) + markupUnits) * 100n, pow10(b.scale + 6)), 2),
    basis: basisText,
    marginPct: textOf(divideRoundHalfUp(markupUnits * 100n, pow10(4)), 2),
    marginAlert: false,
  };
}
