/**
 * T-527b - "Items so far": the running list of what the cashier has picked while seating a party or adding items, with a sum for the eye.
 * It is NOT a bill: no VAT, no discounts, no senior/PWD, no service. The server prices the real order. Pure; money goes through @shareat/core/money
 * (exact centavos, no floats). docs/tasks/527-pos-orders-screen.md (Addendum, T-527b).
 */
import { add, money, multiply, ZERO, type Money } from '@shareat/core/money';
import { asStoreMenu, displayUnitPrice, type MenuLike } from './menu-filter';
import type { CartLine } from './payloads';

export interface CartRow {
  /** Index in the cart: the buttons act on it. */
  index: number;
  name: string;
  options: string[];
  note: string | null;
  isPackage: boolean;
  qty: number;
  /** Display price of ONE (a head, for a per-head package; the flat price, for a bundle). Null when the menu no longer holds the item. */
  unit: Money | null;
  /** qty x unit, plus the extra heads of a bundle. Null when `unit` is. */
  total: Money | null;
  /** "up to 6 heads" on a bundle, so a flat price is not read as per head. */
  bundleNote: string | null;
}

/** `heads` is what a package line is billed for (the table's heads); null/0 counts as 1. A bundle's flat price covers N heads, then the extra-head price. */
export function cartRows(cart: readonly CartLine[], menu: MenuLike, heads: number | null): CartRow[] {
  const items = asStoreMenu(menu).items;
  return cart.map((l, index): CartRow => {
    const item = items.find((i) => i.id === l.itemId);
    const variant = item?.variants.find((v) => v.id === l.variantId) ?? item?.variants.find((v) => v.isDefault) ?? item?.variants[0];
    const isPackage = item?.itemType === 'package';
    const options = variant ? variant.optionGroups.flatMap((g) => g.values.filter((v) => l.optionValueIds?.includes(v.id)).map((v) => v.name)) : [];
    const name = `${item?.name ?? 'Item'}${variant?.label ? ` - ${variant.label}` : ''}`;
    const base = { index, name, options, note: l.note ?? null, isPackage };
    if (!item || !variant) return { ...base, qty: l.qty, unit: null, total: null, bundleNote: null };
    const unit = money(displayUnitPrice(variant, l.optionValueIds ?? []));
    const offer = variant.channels.store;
    const bundle = offer.orderable && offer.bundleHeads !== null && offer.bundleHeads > 1 ? offer : null;
    if (isPackage && bundle) {
      const covered = bundle.bundleHeads!;
      const extra = Math.max(0, (heads ?? 1) - covered);
      const extraTotal = extra > 0 && bundle.extraHeadAmount !== null ? multiply(money(bundle.extraHeadAmount), extra) : ZERO;
      return { ...base, qty: 1, unit, total: add(unit, extraTotal), bundleNote: `up to ${covered} heads` };
    }
    const qty = isPackage ? Math.max(1, heads ?? 1) : l.qty;
    return { ...base, qty, unit, total: multiply(unit, qty), bundleNote: null };
  });
}

/** The sum under "Items so far". A line whose price is unknown adds nothing (it shows no price either). */
export function itemsSoFarSum(rows: readonly CartRow[]): Money {
  return add(ZERO, ...rows.map((r) => r.total ?? ZERO));
}
