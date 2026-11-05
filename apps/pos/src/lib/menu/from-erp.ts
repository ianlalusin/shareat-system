/**
 * T-508 S5 (R8) - the ONE adapter from the ERP's store menu (StoreMenuV2) to the shapes the POS screens already use.
 * PURE: no network, no IndexedDB, no React. Source of truth for what each field means: docs/tasks/508 R8.
 * - package = itemType `package`, one StorePackage per orderable store-channel variant (packageId = the ERP variant id).
 * - flavours = the values of the option groups linked to refill items (flavourId = the option value id).
 * - add-ons = `soldInPackageSession`, a la carte = `soldALaCarte`; both rows come from adaptAddons (the single source).
 * - an item the projection left out (no station) is never here, and this file adds nothing the projection did not send.
 */
import type { ErpMenu as StoreMenuV2 } from './types';
import type { InventoryItem, KitchenLocation, Refill, StoreFlavor, StorePackage, StoreRefill } from '@/lib/types';

type Item = StoreMenuV2['items'][number];
type Variant = Item['variants'][number];

export type ErpRefill = Pick<Refill, 'id' | 'name' | 'requiresFlavor' | 'allowedFlavorIds' | 'isActive'>;
export type ErpAddon = Omit<InventoryItem, 'createdAt' | 'updatedAt'> & {
  displayName: string; groupKey: string; groupName: string;
  kitchenLocationId: string | null; kitchenLocationName: string | null;
  soldALaCarte: boolean; soldInPackageSession: boolean;
};

const storePrice = (v: Variant): string | null => (v.channels.store.orderable ? v.channels.store.amount : null);
const label = (name: string, v: Variant): string => (v.label ? `${name} ${v.label}` : name);

export function adaptKitchenLocations(menu: StoreMenuV2): KitchenLocation[] {
  return menu.stations.map((s, i) => ({ id: s.id, name: s.name, sortOrder: i, isActive: true, slaMinutes: s.slaMinutes, printOnOutage: s.printOnOutage }));
}

const stationName = (menu: StoreMenuV2, id: string | null): string | null => (id ? menu.stations.find((s) => s.id === id)?.name ?? null : null);

/** Flavour option values of one refill item: orderable in the store channel only. */
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

export function adaptPackages(menu: StoreMenuV2): StorePackage[] {
  const flavoursByRefill = new Map(refillItems(menu).map((r) => [r.id, flavoursOfRefill(r).map((f) => f.flavorId)]));
  const out: StorePackage[] = [];
  for (const item of menu.items) {
    if (item.itemType !== 'package') continue;
    for (const v of item.variants) {
      const amount = storePrice(v);
      if (amount === null) continue; // not orderable here, or a package with no price: never offered
      const offer = v.channels.store;
      const bundleHeads = offer.orderable ? offer.bundleHeads : null;
      const p: StorePackage = {
        packageId: v.id, packageName: label(item.name, v), isEnabled: true, pricePerHead: Number(amount),
        kitchenLocationId: item.stationId, kitchenLocationName: stationName(menu, item.stationId),
        refillsAllowed: [...v.refillItemIds],
        flavorsAllowed: [...new Set(v.refillItemIds.flatMap((id) => flavoursByRefill.get(id) ?? []))],
        sortOrder: item.sortOrder * 1000 + v.sortOrder, menuScheduleId: null,
      };
      if (bundleHeads !== null) {
        p.isBundle = true; p.bundlePrice = Number(amount); p.bundleMaxCap = bundleHeads;
        p.bundleExtraHeadPrice = Number(offer.orderable ? offer.extraHeadAmount ?? 0 : 0);
      }
      out.push(p);
    }
  }
  return out;
}

/** One row per orderable store variant of every add-on / a-la-carte item. Rows carry both flags; callers pick the list they need. */
export function adaptAddons(menu: StoreMenuV2): ErpAddon[] {
  const catName = new Map(menu.categories.map((c) => [c.id, c.name]));
  const out: ErpAddon[] = [];
  for (const item of menu.items) {
    if (item.itemType !== 'a_la_carte' || !(item.soldALaCarte || item.soldInPackageSession)) continue;
    const single = item.variants.length === 1 && !item.variants[0]!.label;
    for (const v of item.variants) {
      const amount = storePrice(v);
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
