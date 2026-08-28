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
 */
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

export function computeBranchPrice(rule: BranchPriceRule, basis: string): BranchPrice {
  const b = Number(basis);
  const threshold = rule.marginAlertThresholdPct == null ? null : Number(rule.marginAlertThresholdPct);

  if (rule.pricingMode === 'fixed') {
    const price = Number(rule.fixedAmount ?? 0);
    const marginPct = b > 0 ? ((price - b) / b) * 100 : null;
    return {
      price: price.toFixed(2),
      basis: b.toFixed(4),
      marginPct: marginPct == null ? null : marginPct.toFixed(2),
      marginAlert: threshold != null && marginPct != null && marginPct < threshold,
    };
  }

  if (rule.pricingMode === 'fixed_markup') {
    const markup = Number(rule.fixedMarkupAmount ?? 0);
    const marginPct = b > 0 ? (markup / b) * 100 : null;
    return {
      price: (b + markup).toFixed(2),
      basis: b.toFixed(4),
      marginPct: marginPct == null ? null : marginPct.toFixed(2),
      // The markup is fixed in pesos but the margin% shrinks as the basis grows, so the
      // threshold is useful here too - v1 alerts in this mode for exactly that reason.
      marginAlert: threshold != null && marginPct != null && marginPct < threshold,
    };
  }

  const markupPct = Number(rule.markupPercent ?? 0);
  return {
    price: (b * (1 + markupPct / 100)).toFixed(2),
    basis: b.toFixed(4),
    marginPct: markupPct.toFixed(2),
    marginAlert: false,
  };
}
