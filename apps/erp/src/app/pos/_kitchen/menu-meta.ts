/**
 * T-529 R1/R2 - the two things a kitchen browser or a server's phone needs from the menu (it has no snapshot): the stations (name, SLA, print flag) and,
 * per package variant, which refills it offers. A pure function over the projected menu: the route `/api/pos/menu-meta` builds it from `loadStoreMenu`, and
 * the store tablet builds the same thing from its own cached snapshot, so both read one shape. Nothing here is a business value: it is all menu master data.
 */
import type { MenuLike } from '../_orders/menu-filter';
import { asStoreMenu } from '../_orders/menu-filter';
import { refillMeats, type RefillMeat } from '../_refills/meats';

export interface MenuMetaStation {
  id: string;
  name: string;
  slaMinutes: number;
  printOnOutage: boolean;
}
export interface MenuMeta {
  stations: MenuMetaStation[];
  /** Package variant id -> its refills, in the order the package lists them. An id the menu no longer holds is left out. */
  refillCatalog: Record<string, RefillMeat[]>;
}

export function menuMetaOf(menu: MenuLike): MenuMeta {
  const m = asStoreMenu(menu);
  const refillCatalog: MenuMeta['refillCatalog'] = {};
  for (const item of m.items) {
    if (item.itemType !== 'package') continue;
    for (const v of item.variants) refillCatalog[v.id] = refillMeats(m, v.id);
  }
  return { stations: m.stations.map((s) => ({ id: s.id, name: s.name, slaMinutes: s.slaMinutes, printOnOutage: s.printOnOutage })), refillCatalog };
}
