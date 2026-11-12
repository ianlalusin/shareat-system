/**
 * T-527 R4 - what the menu picker shows, as pure functions over the snapshot's menu. docs/tasks/527-pos-orders-screen.md.
 * Row 307: an item that is sold out (withdrawn) or not open yet (outside hours) is SHOWN but cannot be tapped. An item the store does not sell now at all
 * (no offer, no price basis, a rule that would price it below zero) is HIDDEN: it is not sellable, which is different from sold out.
 */
import { add, money } from '@shareat/core/money';
import type { ProjectedStoreMenu, StoreMenuV2 } from '@shareat/domain';
import { hasStoreSlots, resolveSlot, type DaypartHours, type SlotAnswer } from '@/lib/pos-device/daypart-client';

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

/**
 * T-559: WHEN a price is read. `hours` is the menu's own (absent without dayparts) and `at` the instant: now for the picker, a line's `addedAtDevice` for a
 * pending line. The same slot logic as the server's `menus.at(lineTime)`, so the device figure equals the server's.
 */
export interface PriceWhen {
  hours: DaypartHours | undefined;
  at: Date;
}
/** The store offer of a variant. With no `when` it is the menu's `channels.store` as it was when the snapshot was fetched. */
export function storeAnswer(variant: ProjectedVariant, when?: PriceWhen): SlotAnswer {
  if (when) return resolveSlot(variant, when.hours, when.at);
  const c = variant.channels.store;
  return c.orderable ? { orderable: true, offer: c } : { orderable: false, reason: c.notOffered };
}
export const whenOf = (m: StoreMenuV2, at: Date): PriceWhen => ({ hours: m.hours, at });

export interface PickerItem {
  id: string;
  name: string;
  itemType: 'package' | 'a_la_carte';
  orderable: boolean;
  /** 'Sold out', or `From HH:MM`; null while orderable. */
  label: string | null;
  variants: ProjectedVariant[];
  /** T-559: the clock this item was judged at; `orderableVariants` and the price helpers read it. */
  when: PriceWhen;
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
export function pickerCatalog(menu: StoreMenuV2 | ProjectedStoreMenu, ctx: { packageOpen: boolean; takeOut?: boolean; at?: Date }): PickerCategory[] {
  const m = asStoreMenu(menu);
  const when = whenOf(m, ctx.at ?? new Date());
  const out: PickerCategory[] = [];
  for (const cat of [...m.categories].sort(bySort)) {
    const items: PickerItem[] = [];
    for (const item of [...m.items].filter((i) => i.categoryId === cat.id).sort(bySort)) {
      if (item.itemType !== 'package' && item.itemType !== 'a_la_carte') continue; // refills belong to T-529
      if (item.itemType === 'package' ? ctx.takeOut === true : !(item.soldALaCarte || (ctx.packageOpen && item.soldInPackageSession))) continue;
      const answers = item.variants.map((v) => storeAnswer(v, when));
      const orderable = answers.some((a) => a.orderable);
      const opens = opensAt(answers);
      if (!orderable && !opens && !answers.some((a) => !a.orderable && (a.reason === 'withdrawn' || a.reason === 'outside_hours'))) continue;
      // T-559 R2: a package whose window is closed is ONE muted line under the picker (`closedPackages`), not a tile.
      if (!orderable && opens && item.itemType === 'package') continue;
      items.push({ id: item.id, name: item.name, itemType: item.itemType, orderable, label: orderable ? null : opens ? `From ${opens}` : 'Sold out', variants: item.variants, when });
    }
    if (items.length > 0) out.push({ id: cat.id, name: cat.name, items });
  }
  return out;
}

/** The store-local 'HH:MM' a closed item opens, when some variant is shut only by the clock (a closed window, or a menu from before slots); else undefined. */
function opensAt(answers: readonly SlotAnswer[]): string | undefined {
  return answers.flatMap((a) => (!a.orderable && (a.reason === 'outside_hours' || a.reason === 'no_price_for_this_time') && a.availableFrom ? [a.availableFrom] : [])).sort()[0];
}

export interface ClosedPackage {
  itemId: string;
  name: string;
  availableFrom: string | null;
}
/** Packages the store sells whose window is closed at `at` (no variant orderable, and one would open): the cashier's "Not available now" line. Sold-out ones are not here. */
export function closedPackages(menu: StoreMenuV2 | ProjectedStoreMenu, at: Date, ctx: { takeOut?: boolean } = {}): ClosedPackage[] {
  if (ctx.takeOut === true) return [];
  const m = asStoreMenu(menu);
  const when = whenOf(m, at);
  const out: ClosedPackage[] = [];
  for (const item of [...m.items].sort(bySort)) {
    if (item.itemType !== 'package') continue;
    const answers = item.variants.map((v) => storeAnswer(v, when));
    const opens = opensAt(answers);
    if (!answers.some((a) => a.orderable) && opens) out.push({ itemId: item.id, name: item.name, availableFrom: opens });
  }
  return out;
}
/** The one line under the package picker; null when nothing is closed. */
export const closedPackagesText = (closed: readonly ClosedPackage[]): string | null =>
  closed.length === 0 ? null : `Not available now: ${closed.map((c) => (c.availableFrom ? `${c.name} from ${c.availableFrom}` : c.name)).join(', ')}`;

/** Selected package lines the clock has since closed (no variant of theirs orderable at `at`): the form must take them off. Refills and a la carte lines are never judged here. */
export function goneLines<L extends { itemId: string; variantId?: string }>(cart: readonly L[], menu: StoreMenuV2 | ProjectedStoreMenu, at: Date): L[] {
  const m = asStoreMenu(menu);
  const when = whenOf(m, at);
  return cart.filter((l) => {
    const item = m.items.find((i) => i.id === l.itemId);
    if (item?.itemType !== 'package') return false;
    const v = item.variants.find((x) => x.id === l.variantId) ?? item.variants.find((x) => x.isDefault) ?? item.variants[0];
    return v !== undefined && !storeAnswer(v, when).orderable;
  });
}

/** The variants the cashier can pick between: a sold-out size is not offered. */
export const orderableVariants = (item: PickerItem): ProjectedVariant[] => [...item.variants].filter((v) => storeAnswer(v, item.when).orderable).sort(bySort);

/**
 * The display price of a line already on an order (T-559): its slot at `when`. A dayparted variant with no price for that minute has NO price (null: the bill
 * stops, Pay stays off) rather than a guess from the cached live price. A variant without slots keeps the channel price, as before.
 */
export function pendingPrice(variant: ProjectedVariant, optionValueIds: readonly string[], when: PriceWhen): string | null {
  if (!storeAnswer(variant, when).orderable && hasStoreSlots(variant)) return null;
  return displayUnitPrice(variant, optionValueIds, when);
}

/** Display only (the server sets the real price): the store amount plus the chosen options' store deltas. `when` reads the slot at that time (T-559). */
export function displayUnitPrice(variant: ProjectedVariant, optionValueIds: readonly string[], when?: PriceWhen): string {
  const a = storeAnswer(variant, when);
  let total = money(a.orderable && a.offer.amount !== null ? a.offer.amount : '0');
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
