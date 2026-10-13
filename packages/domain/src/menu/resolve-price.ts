/**
 * T-401 S2 - what an offer row means as a price, at the instant it was read. docs/tasks/401-erp-menu-catalog-master.md R15.
 *
 * PURE: no database, no clock. The caller passes the row in force (`menuRepo.offersInForce`) and, for an online rule, the STORE
 * row in force at the SAME instant (`basis`). A rule is resolved at read, never stored, so when the store price changes the
 * online price follows from that instant with no second write (the way T-151's `branchPriceFor` resolves at read).
 *
 * Exact decimal arithmetic, rounded ONCE, half-up on the absolute value, to the centavo (`shared/exact-decimal`, the rule
 * `computeBranchPrice` uses). A rule never clamps: a result below zero is "not offered" with its reason, never 0.00.
 */
import { decimal } from '@shareat/core/money';
import { divideRoundHalfUp, pow10, textOf } from '../shared/exact-decimal';

/** The price columns of one offer row (structurally what `menuRepo.OfferPriceFields` is; no db import here). */
export interface OfferPriceInput {
  readonly withdrawn: boolean;
  readonly pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
  readonly amount: string | null;
  readonly bundleHeads: number | null;
  readonly extraHeadAmount: string | null;
  readonly markupPercent: string | null;
  readonly fixedMarkupAmount: string | null;
}

export interface ResolvableOffer extends OfferPriceInput {
  /** The store-channel row in force at the same instant, for an online rule; null when the store has none. */
  readonly basis?: OfferPriceInput | null;
}

export type NotOfferedReason = 'no_basis' | 'withdrawn' | 'rule_below_zero';

export type ResolvedOfferPrice =
  | {
      /** 2-decimal text; null only for a refill (a zero-price serving carries no price). */
      readonly amount: string | null;
      /** Per guest beyond `bundleHeads`; null when the offer is not a bundle. */
      readonly extraHeadAmount: string | null;
      readonly bundleHeads: number | null;
    }
  | { readonly notOffered: NotOfferedReason };

/** A 2-decimal money text as centavos. */
const centavos = (v: string): bigint => {
  const d = decimal(v, '14,2');
  return BigInt(d.replace('.', ''));
};

/** A 4-decimal percent text (signed) as ten-thousandths of a percent. */
const percentUnits = (v: string): bigint => BigInt(decimal(v, '8,4').replace('.', ''));

export function resolveOfferPrice(row: ResolvableOffer): ResolvedOfferPrice {
  if (row.withdrawn) return { notOffered: 'withdrawn' };
  if (row.pricingMode === 'fixed') {
    return { amount: row.amount, extraHeadAmount: row.extraHeadAmount, bundleHeads: row.bundleHeads };
  }

  const basis = row.basis ?? null;
  if (!basis) return { notOffered: 'no_basis' };
  if (basis.withdrawn) return { notOffered: 'withdrawn' };
  if (basis.amount === null) return { notOffered: 'no_basis' }; // a refill basis carries no price to follow

  const apply = (storeAmount: string): bigint => {
    const base = centavos(storeAmount);
    if (row.pricingMode === 'percent_markup') {
      // base x (100 + p) / 100, p in ten-thousandths of a percent: base x (1_000_000 + p) / 1_000_000, rounded once.
      return divideRoundHalfUp(base * (pow10(6) + percentUnits(row.markupPercent ?? '0')), pow10(6));
    }
    return base + centavos(row.fixedMarkupAmount ?? '0');
  };

  const amount = apply(basis.amount);
  const extra = basis.extraHeadAmount === null ? null : apply(basis.extraHeadAmount);
  if (amount < 0n || (extra !== null && extra < 0n)) return { notOffered: 'rule_below_zero' };
  return {
    amount: textOf(amount, 2),
    extraHeadAmount: extra === null ? null : textOf(extra, 2),
    bundleHeads: basis.bundleHeads,
  };
}
