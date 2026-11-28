/**
 * T-649 - what an item costs a customer, from the customer's price list.
 *
 * ONE resolver for the order form, the order line and the price-list screen. The customer's own list wins; a customer with none uses the organisation's default
 * list; with neither there is no quote, and the person types the rate (today's behaviour). A list row is a fixed rate, or the delivery cost + an amount, or the
 * delivery cost + a percent - the same arithmetic as the branch price (`computeBranchPrice`) over the same cost (`costBasisFor`).
 *
 * ⛔ Null, never zero, never another list: a missing quote means nobody has priced this item for this customer, and a made-up number is how something ships free.
 * ⚠️ The order line CAPTURES the number at creation; a later cost change never moves an old order.
 */
import { customersRepo, itemsRepo, type PriceListItemRow, type Tx } from '@shareat/db';
import { computeBranchPrice } from '../items/branch-price';

export type QuoteBasis = 'fixed' | 'cost_plus';
export type NoQuoteReason = 'no_list' | 'not_on_list' | 'no_delivery_cost';

export interface Quote {
  rate: string;
  basis: QuoteBasis;
  listId: string;
  /** The unit the list quotes in, when it differs from the item's base unit. */
  unit: string | null;
}

export type QuoteResult = { quote: Quote; reason: null } | { quote: null; reason: NoQuoteReason; listId: string | null };

/** The delivery cost a markup adds to (a plain decimal), or undefined when no delivery has landed yet. */
export type CostOf = (itemId: string) => Promise<string | undefined>;

/** A `CostOf` that asks `costBasisFor` once per item. shortcut: two queries per distinct markup item, no batched read exists; upgrade if a list grows past a few hundred markup rows. */
export function costBasisReader(tx: Tx, orgId: string): CostOf {
  const memo = new Map<string, string | undefined>();
  return async (itemId) => {
    if (!memo.has(itemId)) memo.set(itemId, (await itemsRepo.costBasisFor(tx, orgId, itemId))?.basis);
    return memo.get(itemId);
  };
}

/** One list row's price today, or null when it cannot be priced (a markup with no delivery cost yet). */
export async function priceOfRow(row: PriceListItemRow, costOf: CostOf): Promise<{ rate: string; basis: QuoteBasis } | null> {
  if (row.pricingMode === 'fixed') return row.rate === null ? null : { rate: row.rate, basis: 'fixed' };
  const cost = await costOf(row.itemId);
  if (cost === undefined) return null;
  const { price } = computeBranchPrice({ pricingMode: row.pricingMode, fixedMarkupAmount: row.markupAmount, markupPercent: row.markupPercent }, cost);
  return { rate: price, basis: 'cost_plus' };
}

/** The list a customer is priced from: its own, else the org's default, else none. */
export async function listIdFor(tx: Tx, orgId: string, customerId: string): Promise<string | null> {
  const own = await customersRepo.customerPriceListId(tx, orgId, customerId);
  if (own) return own;
  return (await customersRepo.getDefaultPriceList(tx, orgId))?.id ?? null;
}

/** The quote, or the reason there is none (the order refusal and the screens say which). */
export async function quoteWithReason(tx: Tx, orgId: string, customerId: string, itemId: string): Promise<QuoteResult> {
  const listId = await listIdFor(tx, orgId, customerId);
  if (!listId) return { quote: null, reason: 'no_list', listId: null };
  const row = await customersRepo.getPriceListItem(tx, orgId, listId, itemId);
  if (!row) return { quote: null, reason: 'not_on_list', listId };
  const priced = await priceOfRow(row, costBasisReader(tx, orgId));
  if (!priced) return { quote: null, reason: 'no_delivery_cost', listId };
  return { quote: { rate: priced.rate, basis: priced.basis, listId, unit: row.unit }, reason: null };
}

export async function quoteForCustomer(tx: Tx, orgId: string, customerId: string, itemId: string): Promise<Quote | null> {
  return (await quoteWithReason(tx, orgId, customerId, itemId)).quote;
}
