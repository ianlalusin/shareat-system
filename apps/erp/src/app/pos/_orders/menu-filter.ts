/**
 * T-527 R4 - what the menu picker shows, as pure functions over the snapshot's menu. docs/tasks/527-pos-orders-screen.md.
 * Row 307: an item that is sold out (withdrawn) or not open yet (outside hours) is SHOWN but cannot be tapped. An item the store does not sell now at all
 * (no offer, no price basis, a rule that would price it below zero) is HIDDEN: it is not sellable, which is different from sold out.
 */
import { add, money } from '@shareat/core/money';
import type { ProjectedStoreMenu, StoreMenuV2 } from '@shareat/domain';

/** The snapshot holds the menu as `{ menu, contentHash, nextChangeAt }`; a bare `StoreMenuV2` is accepted too. */
export type MenuLike = StoreMenuV2 | ProjectedStoreMenu;
/** The barrel does not export these two, so they are read off the menu type. Re-exported so a `'use client'` file can name them without importing the barrel (T-266). */
export type Variant = StoreMenuV2['items'][number]['variants'][number];
export type OptionGroup = Variant['optionGroups'][number];
type ProjectedVariant = Variant;
type ProjectedOptionGroup = OptionGroup;
export function asStoreMenu(m: MenuLike): StoreMenuV2 {
  return 'menu' in m ? m.menu : m;
}

export interface PickerItem {
  id: string;
  name: string;
  itemType: 'package' | 'a_la_carte';
  orderable: boolean;
  /** 'Sold out', or `From HH:MM`; null while orderable. */
  label: string | null;
  variants: ProjectedVariant[];
}
export interface PickerCategory {
  id: string;
  name: string;
  items: PickerItem[];
}

const bySort = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;

/**
 * `takeOut`: a take-out order holds no package (T-524 refuses one), so packages never show. In a dine-in context a package shows whatever its
 * `soldALaCarte` says: that flag is about selling it BY ITSELF as a dish and the catalog defaults a package to false. An a la carte item keeps the
 * flag test (or `soldInPackageSession` while a package is open).
 */
export function pickerCatalog(menu: StoreMenuV2 | ProjectedStoreMenu, ctx: { packageOpen: boolean; takeOut?: boolean }): PickerCategory[] {
  const m = asStoreMenu(menu);
  const out: PickerCategory[] = [];
  for (const cat of [...m.categories].sort(bySort)) {
    const items: PickerItem[] = [];
    for (const item of [...m.items].filter((i) => i.categoryId === cat.id).sort(bySort)) {
      if (item.itemType !== 'package' && item.itemType !== 'a_la_carte') continue; // refills belong to T-529
      if (item.itemType === 'package' ? ctx.takeOut === true : !(item.soldALaCarte || (ctx.packageOpen && item.soldInPackageSession))) continue;
      const offers = item.variants.map((v) => v.channels.store);
      const orderable = offers.some((o) => o.orderable);
      if (!orderable && !offers.some((o) => !o.orderable && (o.notOffered === 'withdrawn' || o.notOffered === 'outside_hours'))) continue;
      const opens = offers.flatMap((o) => (!o.orderable && o.notOffered === 'outside_hours' && o.availableFrom ? [o.availableFrom] : [])).sort()[0];
      items.push({ id: item.id, name: item.name, itemType: item.itemType, orderable, label: orderable ? null : opens ? `From ${opens}` : 'Sold out', variants: item.variants });
    }
    if (items.length > 0) out.push({ id: cat.id, name: cat.name, items });
  }
  return out;
}

/** The variants the cashier can pick between: a sold-out size is not offered. */
export const orderableVariants = (item: PickerItem): ProjectedVariant[] => [...item.variants].filter((v) => v.channels.store.orderable).sort(bySort);

/** Display only (the server sets the real price): the store amount plus the chosen options' store deltas. */
export function displayUnitPrice(variant: ProjectedVariant, optionValueIds: readonly string[]): string {
  const offer = variant.channels.store;
  let total = money(offer.orderable && offer.amount !== null ? offer.amount : '0');
  for (const g of variant.optionGroups) {
    for (const v of g.values) {
      if (optionValueIds.includes(v.id) && v.channels.store.orderable) total = add(total, money(v.channels.store.priceDelta));
    }
  }
  return total;
}

/** One variant and no option group adds with one tap; anything else opens the choice sheet. */
export function needsChoiceSheet(item: PickerItem): boolean {
  const variants = orderableVariants(item);
  return variants.length > 1 || variants.some((v) => v.optionGroups.length > 0);
}

/** `single` is radio tiles, `multi` is toggles: either way the count must sit between min and max (and a single group never holds two). */
export function isOptionChoiceValid(group: ProjectedOptionGroup, chosenValueIds: readonly string[]): boolean {
  const n = new Set(chosenValueIds).size;
  return n >= group.minSelections && n <= group.maxSelections && (group.selectionMode !== 'single' || n <= 1);
}
