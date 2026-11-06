/**
 * T-524 R7 - `priceSession`, the ONE arithmetic function of the POS v2 bill (docs/tasks/524-pos-v2-domain.md R7). Pure: no database, no clock,
 * no rate of its own. The caller reads the two percents (as basis points, business rules `tax.vat_percent` and `pos.senior_pwd_discount_percent`:
 * 12% = 1200n, 20% = 2000n) and passes them in; completeSale and getSessionBill both call this, so the figure the till shows is the figure
 * the server writes.
 *
 * Money is integer centavos inside (bigint, never a float). Each discount is rounded half-up ONCE, from the exact fraction:
 *   senior / PWD on a VAT org : VAT removed = G - G x 10000 / (10000 + vatBp)      = G x vatBp / (10000 + vatBp)
 *                               discount   = (G - VAT removed) x scBp / 10000      = G x scBp  / (10000 + vatBp)   (VAT removed is NOT rounded first)
 *   senior / PWD, non-VAT org : VAT removed = 0 ; discount = G x scBp / 10000
 *   percent (preset / custom) : G x value / 100        fixed : sum over the covered units of min(value, that unit's price)
 * Why the VAT is NOT rounded before the 20% is taken (audit F11): the statute takes 20% of the VAT-free price, and that price is the exact fraction G x 10000 / (10000 + vatBp);
 * rounding the VAT first would round twice and can move the discount by a centavo, so both figures are rounded half-up ONCE, each from the exact fraction.
 * G is the gross of the units the discount covers. On a bundle line ("up to N" heads, qty 1 at the bundle amount) a unit is a HEAD and
 * its price is the bundle amount allocated exactly over N heads (the extra centavo to the earliest heads); discounts take heads in
 * creation order, so two seniors are two different heads.
 */
import { allocate, fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';

export interface PriceDiscountInput {
  readonly discountId: string;
  readonly kind: 'senior' | 'pwd' | 'preset' | 'custom';
  readonly valueType: 'percent' | 'fixed';
  /** A decimal string: a percent (0-100] or a peso amount per unit. */
  readonly value: string;
  /** Units covered (heads, on a bundle line). */
  readonly qty: number;
}
export interface PriceLineInput {
  readonly lineId: string;
  readonly qty: number;
  readonly unitPrice: string;
  /** null or 1: an ordinary per-unit line. N > 1: a "(up to N)" bundle line (qty 1, unitPrice = the bundle amount). */
  readonly bundleHeads: number | null;
  /** ACTIVE discounts only, in creation order. */
  readonly discounts: readonly PriceDiscountInput[];
}
export interface PriceSnapshot {
  /** organizations.tax_type = 'vat' */
  readonly vatRegistered: boolean;
  readonly vatPercentBasisPoints: bigint;
  readonly scPwdPercentBasisPoints: bigint;
  /** NON-cancelled lines only. */
  readonly lines: readonly PriceLineInput[];
}
export interface PricedDiscount {
  readonly discountId: string;
  /** The covered units' gross: what the statutory record's gross_amount takes. */
  readonly coveredGross: Money;
  /** '0.00' except senior/PWD on a VAT org. */
  readonly vatRemoved: Money;
  readonly discountAmount: Money;
}
export interface PricedLine {
  readonly lineId: string;
  readonly gross: Money;
  readonly discountTotal: Money;
  readonly net: Money;
  readonly discounts: PricedDiscount[];
}
export interface PricedSession {
  readonly lines: PricedLine[];
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly total: Money;
}

/** n / d rounded half-up, n >= 0, d > 0. */
function halfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/** A decimal string as { n, scale }: value = n / 10^scale. */
function scaled(v: string): { n: bigint; scale: bigint } {
  const [whole = '0', frac = ''] = v.trim().split('.');
  return { n: BigInt(whole + frac), scale: BigInt(frac.length) };
}

function unitShares(line: PriceLineInput): bigint[] {
  const gross = money(BigInt(line.qty) * toCentavos(money(line.unitPrice)));
  if (line.bundleHeads !== null && line.bundleHeads > 1) return allocate(gross, line.bundleHeads).map(toCentavos);
  return Array.from({ length: line.qty }, () => toCentavos(money(line.unitPrice)));
}

export function priceSession(snapshot: PriceSnapshot): PricedSession {
  const vatBp = snapshot.vatPercentBasisPoints;
  const scBp = snapshot.scPwdPercentBasisPoints;
  const lines: PricedLine[] = snapshot.lines.map((line) => {
    const shares = unitShares(line);
    const gross = shares.reduce((a, s) => a + s, 0n);
    let cursor = 0;
    const discounts = line.discounts.map((d): PricedDiscount => {
      const covered = shares.slice(cursor, cursor + d.qty);
      cursor += d.qty;
      const g = covered.reduce((a, s) => a + s, 0n);
      let vat = 0n;
      let amount: bigint;
      if (d.kind === 'senior' || d.kind === 'pwd') {
        if (snapshot.vatRegistered) {
          vat = halfUp(g * vatBp, 10000n + vatBp);
          amount = halfUp(g * scBp, 10000n + vatBp);
        } else {
          amount = halfUp(g * scBp, 10000n);
        }
      } else if (d.valueType === 'percent') {
        const v = scaled(d.value);
        amount = halfUp(g * v.n, 100n * 10n ** v.scale);
      } else {
        const each = toCentavos(money(d.value));
        amount = covered.reduce((a, s) => a + (s < each ? s : each), 0n);
      }
      return { discountId: d.discountId, coveredGross: fromCentavos(g), vatRemoved: fromCentavos(vat), discountAmount: fromCentavos(amount) };
    });
    const discountTotal = discounts.reduce((a, d) => a + toCentavos(d.vatRemoved) + toCentavos(d.discountAmount), 0n);
    return { lineId: line.lineId, gross: fromCentavos(gross), discountTotal: fromCentavos(discountTotal), net: fromCentavos(gross - discountTotal), discounts };
  });
  const subtotal = lines.reduce((a, l) => a + toCentavos(l.gross), 0n);
  const discountTotal = lines.reduce((a, l) => a + toCentavos(l.discountTotal), 0n);
  return { lines, subtotal: fromCentavos(subtotal), discountTotal: fromCentavos(discountTotal), total: fromCentavos(subtotal - discountTotal) };
}
