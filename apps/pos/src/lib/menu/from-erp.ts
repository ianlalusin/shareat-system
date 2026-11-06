/**
 * T-508 S5 (R8) - the ONE adapter from the ERP's store menu (StoreMenuV2) to the shapes the POS screens already use.
 * PURE: no network, no IndexedDB, no React. Source of truth for what each field means: docs/tasks/508 R8.
 * - package = itemType `package`, one StorePackage per orderable store-channel variant (packageId = the ERP variant id).
 * - flavours = the values of the option groups linked to refill items (flavourId = the option value id).
 * - add-ons = `soldInPackageSession`, a la carte = `soldALaCarte`; both rows come from adaptAddons (the single source).
 * - an item the projection left out (no station) is never here, and this file adds nothing the projection did not send.
 * - T-510 S4b: every adapter takes `now` (epoch ms, default the clock). A dayparted variant carries `slots`; the live one is the slot whose window
 *   holds `now` in the store's zone (`storeOfferOf`). Zero or several holding -> not offered, never another window's price.
 */
import type { ErpMenu as StoreMenuV2 } from './types';
import { contains, nextOpening } from './daypart-client';
import type { InventoryItem, KitchenLocation, Refill, StoreFlavor, StorePackage, StoreRefill } from '@/lib/types';

type Item = StoreMenuV2['items'][number];
type Variant = Item['variants'][number];
type OrderableOffer = Extract<Variant['channels']['store'], { orderable: true }>;

export type ErpRefill = Pick<Refill, 'id' | 'name' | 'requiresFlavor' | 'allowedFlavorIds' | 'isActive'>;
export type ErpAddon = Omit<InventoryItem, 'createdAt' | 'updatedAt'> & {
  displayName: string; groupKey: string; groupName: string;
  kitchenLocationId: string | null; kitchenLocationName: string | null;
  soldALaCarte: boolean; soldInPackageSession: boolean;
};
export interface ClosedPackage { packageId: string; packageName: string; availableFrom: string | null }

/**
 * The store-channel offer a variant has at `now`, or null (not offered). Only slots that carry a STORE row count (a daypart that prices just the
 * online channel says nothing about the till). With none: the server's `channels.store` (no dayparts, or online-only dayparts). With some: the ONE of
 * those whose window holds `now`; none, several, an unknown window, or no `hours` all fail closed. A withdrawn store row is a row (holding it = not offered).
 */
type Slot = NonNullable<Variant['slots']>[number];
const hasStoreRow = (s: Slot): boolean => s.store.orderable || s.store.notOffered !== 'no_offer';
export function storeOfferOf(v: Variant, menu: StoreMenuV2, now: number = Date.now()): OrderableOffer | null {
  const rows = (v.slots ?? []).filter(hasStoreRow);
  if (rows.length === 0) return v.channels.store.orderable ? v.channels.store : null;
  const hours = menu.hours;
  if (!hours) return null;
  const at = new Date(now);
  const holding = rows.filter((s) => {
    const w = hours.dayparts.find((d) => d.id === s.daypartId);
    return !!w && contains(w, at, hours.timeZone);
  });
  const only = holding.length === 1 ? holding[0]!.store : null;
  return only && only.orderable ? only : null;
}

const storePrice = (o: OrderableOffer | null): string | null => (o ? o.amount : null);
const label = (name: string, v: Variant): string => (v.label ? `${name} ${v.label}` : name);

export function adaptKitchenLocations(menu: StoreMenuV2): KitchenLocation[] {
  return menu.stations.map((s, i) => ({ id: s.id, name: s.name, sortOrder: i, isActive: true, slaMinutes: s.slaMinutes, printOnOutage: s.printOnOutage }));
}

const stationName = (menu: StoreMenuV2, id: string | null): string | null => (id ? menu.stations.find((s) => s.id === id)?.name ?? null : null);

/** Flavour option values of one refill item: orderable in the store channel only. Refills and flavours are NOT window-gated (T-510 R5, v1). */
function flavoursOfRefill(item: Item): StoreFlavor[] {
  const out: StoreFlavor[] = [];
  for (const v of item.variants) for (const g of v.optionGroups) for (const val of g.values) {
    if (val.channels.store.orderable) out.push({ flavorId: val.id, flavorName: val.name, isEnabled: true, sortOrder: val.sortOrder });
  }
  return out;
}

const refillItems = (menu: StoreMenuV2): Item[] => menu.items.filter((i) => i.itemType === 'refill');

export function adaptFlavors(menu: StoreMenuV2): StoreFlavor[] {
  const seen = new Map<string, StoreFlavor>();
  for (const r of refillItems(menu)) for (const f of flavoursOfRefill(r)) if (!seen.has(f.flavorId)) seen.set(f.flavorId, f);
  return [...seen.values()];
}

export function adaptRefills(menu: StoreMenuV2): StoreRefill[] {
  return refillItems(menu).map((r) => ({
    refillId: r.id, refillName: r.name, isEnabled: true, sortOrder: r.sortOrder,
    kitchenLocationId: r.stationId, kitchenLocationName: stationName(menu, r.stationId),
    flavorsAllowed: flavoursOfRefill(r).map((f) => f.flavorId),
  }));
}

/** The "global refill" rows RefillPOSModal reads to decide whether a refill needs a flavour. */
export function adaptGlobalRefills(menu: StoreMenuV2): ErpRefill[] {
  return refillItems(menu).map((r) => {
    const ids = flavoursOfRefill(r).map((f) => f.flavorId);
    return { id: r.id, name: r.name, requiresFlavor: ids.length > 0, allowedFlavorIds: ids, isActive: true };
  });
}

export function adaptPackages(menu: StoreMenuV2, now: number = Date.now()): StorePackage[] {
  const flavoursByRefill = new Map(refillItems(menu).map((r) => [r.id, flavoursOfRefill(r).map((f) => f.flavorId)]));
  const out: StorePackage[] = [];
  for (const item of menu.items) {
    if (item.itemType !== 'package') continue;
    for (const v of item.variants) {
      const offer = storeOfferOf(v, menu, now);
      const amount = storePrice(offer);
      if (!offer || amount === null) continue; // not orderable now, or a package with no price: never offered
      const bundleHeads = offer.bundleHeads;
      const p: StorePackage = {
        packageId: v.id, packageName: label(item.name, v), isEnabled: true, pricePerHead: Number(amount),
        kitchenLocationId: item.stationId, kitchenLocationName: stationName(menu, item.stationId),
        refillsAllowed: [...v.refillItemIds],
        flavorsAllowed: [...new Set(v.refillItemIds.flatMap((id) => flavoursByRefill.get(id) ?? []))],
        sortOrder: item.sortOrder * 1000 + v.sortOrder, menuScheduleId: null,
      };
      if (bundleHeads !== null) {
        p.isBundle = true; p.bundlePrice = Number(amount); p.bundleMaxCap = bundleHeads;
        p.bundleExtraHeadPrice = Number(offer.extraHeadAmount ?? 0);
      }
      out.push(p);
    }
  }
  return out;
}

/**
 * Packages the store sells whose window is closed at `now`, for the cashier's "Not available now" line. Closed = no store slot holds now and at least
 * one would offer it. Two slots holding at once is a data fault, not "closed": it is left out of both lists.
 * A menu from before S4b (no slots, the channel says `outside_hours`) is listed from the channel's own `availableFrom`.
 */
export function adaptClosedPackages(menu: StoreMenuV2, now: number = Date.now()): ClosedPackage[] {
  const out: ClosedPackage[] = [];
  const hours = menu.hours;
  const at = new Date(now);
  for (const item of menu.items) {
    if (item.itemType !== 'package') continue;
    for (const v of item.variants) {
      let availableFrom: string | null;
      const rows = (v.slots ?? []).filter(hasStoreRow);
      if (rows.length === 0) {
        const c = v.channels.store;
        if (c.orderable || c.notOffered !== 'outside_hours') continue;
        availableFrom = c.availableFrom ?? null;
      } else {
        if (!hours) continue;
        const windows = rows.map((s) => ({ s, w: hours.dayparts.find((d) => d.id === s.daypartId) }));
        const opening = windows.filter(({ s, w }) => s.store.orderable && w).map(({ w }) => w!);
        if (opening.length === 0 || windows.some(({ w }) => w && contains(w, at, hours.timeZone))) continue;
        availableFrom = nextOpening(opening, at, hours.timeZone)?.time ?? null;
      }
      out.push({ packageId: v.id, packageName: label(item.name, v), availableFrom });
    }
  }
  return out;
}

/** True when a package is selected but no longer offered (the clock moved past its window): the form must clear it. */
export const packageGone = (selectedId: string | undefined, packages: readonly { packageId: string }[]): boolean =>
  !!selectedId && !packages.some((p) => p.packageId === selectedId);

/** The one line the cashier reads under the package picker; null when nothing is closed. */
export function closedPackagesText(closed: readonly ClosedPackage[] | undefined): string | null {
  if (!closed || closed.length === 0) return null;
  return `Not available now: ${closed.map((c) => (c.availableFrom ? `${c.packageName} from ${c.availableFrom}` : c.packageName)).join(', ')}`;
}

/** One row per orderable store variant of every add-on / a-la-carte item. Rows carry both flags; callers pick the list they need. */
export function adaptAddons(menu: StoreMenuV2, now: number = Date.now()): ErpAddon[] {
  const catName = new Map(menu.categories.map((c) => [c.id, c.name]));
  const out: ErpAddon[] = [];
  for (const item of menu.items) {
    if (item.itemType !== 'a_la_carte' || !(item.soldALaCarte || item.soldInPackageSession)) continue;
    const single = item.variants.length === 1 && !item.variants[0]!.label;
    for (const v of item.variants) {
      const amount = storePrice(storeOfferOf(v, menu, now));
      if (amount === null) continue;
      out.push({
        id: v.id, productId: item.id, name: item.name, variantLabel: v.label, displayName: label(item.name, v),
        kind: single ? 'single' : 'variant', groupKey: single ? v.id : item.id, groupName: item.name,
        category: catName.get(item.categoryId), subCategory: catName.get(item.categoryId), uom: 'pc', barcode: null, imageUrl: null,
        cost: 0, sellingPrice: Number(amount), isActive: true, isAddon: true,
        kitchenLocationId: item.stationId, kitchenLocationName: stationName(menu, item.stationId),
        soldALaCarte: item.soldALaCarte, soldInPackageSession: item.soldInPackageSession,
      });
    }
  }
  return out;
}
