/**
 * T-529 (TESTER) - hand-built menu, tickets and a fake device store for the Kitchen and Refills unit tests. Plain data, no database.
 * The ticket shape is T-524 `listKitchenQueue` / `listRefillQueue` (packages/domain/src/pos/sale.ts `ticket`).
 * The menu follows packages/domain/src/menu/project.ts (StoreMenuV2: `stations` carry slaMinutes and printOnOutage, an item carries `stationId`,
 * a variant carries `refillItemIds`).
 */
import type { StoreMenuV2 } from '@shareat/domain';
import { id as mid, STORE } from './t527-menu';

export const id = mid;
export { STORE };

type Item = StoreMenuV2['items'][number];
type Variant = Item['variants'][number];
type Offer = Variant['channels']['store'];
const live = (amount: string | null): Offer => ({ orderable: true, amount, bundleHeads: null, extraHeadAmount: null });
const noOnline: Offer = { orderable: false, notOffered: 'no_offer' };

export const ST = { grill: id(900), hot: id(901), drinks: id(902) } as const;
/** Sort order is NOT the array order on purpose: Hot kitchen sorts first in the array, Grill sorts first by `sortOrder`. */
export const STATIONS: StoreMenuV2['stations'] = [
  { id: ST.hot, name: 'Hot kitchen', slaMinutes: 20, printOnOutage: true },
  { id: ST.grill, name: 'Grill', slaMinutes: 12, printOnOutage: true },
  { id: ST.drinks, name: 'Drinks', slaMinutes: 5, printOnOutage: false },
];

export const IT = {
  pork: id(910), brisket: id(911), rice: id(912), tea: id(913), starter: id(914),
  unli: id(915), premium: id(916),
  rePork: id(920), reBrisket: id(921), reBulgogi: id(922), reLettuce: id(923), reNoodles: id(924),
} as const;
export const VAR = { unli: id(930), premium: id(931) } as const;

const item = (idv: string, name: string, itemType: Item['itemType'], sortOrder: number, o: { stationId?: string | null; variant?: Partial<Variant>; vid?: string } = {}): Item => ({
  id: idv, categoryId: id(990), name, description: null, itemType, soldALaCarte: itemType === 'a_la_carte', soldInPackageSession: false, dinerOrderable: true, sortOrder,
  stationId: o.stationId ?? null,
  variants: [{ id: o.vid ?? idv, label: null, isDefault: true, sortOrder: 1, channels: { store: live(itemType === 'refill' ? null : '100.00'), online: noOnline }, optionGroups: [], refillItemIds: [], ...o.variant }],
});

/**
 * Two packages with DIFFERENT refill lists, and a refill (Noodles) that belongs to neither. `refillItemIds` is NOT in menu order, so a test can tell
 * "from the package's list" from "every refill on the menu".
 */
export const MENU: StoreMenuV2 = {
  schemaVersion: 2,
  storeId: STORE,
  stations: STATIONS,
  categories: [{ id: id(990), name: 'All', parentId: null, sortOrder: 1 }],
  items: [
    item(IT.pork, 'Pork belly', 'a_la_carte', 1, { stationId: ST.grill }),
    item(IT.brisket, 'Beef brisket', 'a_la_carte', 2, { stationId: ST.grill }),
    item(IT.rice, 'Kimchi fried rice', 'a_la_carte', 3, { stationId: ST.hot }),
    item(IT.tea, 'Iced tea pitcher', 'a_la_carte', 4, { stationId: ST.drinks }),
    item(IT.starter, 'Starter set', 'a_la_carte', 5), // no kitchen station
    item(IT.unli, 'Unli Grill', 'package', 6, { vid: VAR.unli, variant: { refillItemIds: [IT.reBrisket, IT.rePork, IT.reBulgogi] } }),
    item(IT.premium, 'Premium Unli', 'package', 7, { vid: VAR.premium, variant: { refillItemIds: [IT.reLettuce, IT.reBrisket] } }),
    item(IT.rePork, 'Pork belly', 'refill', 8, { stationId: ST.grill }),
    item(IT.reBrisket, 'Beef brisket', 'refill', 9, { stationId: ST.grill }),
    item(IT.reBulgogi, 'Chicken bulgogi', 'refill', 10, { stationId: ST.grill }),
    item(IT.reLettuce, 'Lettuce', 'refill', 11, { stationId: ST.hot }),
    item(IT.reNoodles, 'Noodle refill', 'refill', 12, { stationId: ST.hot }),
  ],
  notOnPos: [],
};

/** The same menu, every station's printOnOutage forced. */
export const menuWithPrint = (print: Record<string, boolean>): StoreMenuV2 => ({
  ...MENU,
  stations: MENU.stations.map((s) => ({ ...s, printOnOutage: print[s.id] ?? s.printOnOutage })),
});

export const NOW = Date.parse('2026-11-07T12:00:00.000Z');
export const minutesAgo = (m: number, extraSeconds = 0): string => new Date(NOW - m * 60_000 - extraSeconds * 1000).toISOString();

export interface TestTicket {
  lineId: string; sessionId: string; standNumber: number | null; sessionMode: string; kind: string; name: string; qty: number; note: string | null; stationId: string | null; addedAtDevice: string;
}
let n = 5000;
export function ticket(o: Partial<TestTicket> & { sessionId: string; addedAtDevice: string }): TestTicket {
  return { lineId: id(n++), standNumber: 5, sessionMode: 'dine_in', kind: 'item', name: 'Pork belly', qty: 1, note: null, stationId: ST.grill, ...o };
}

/** An in-memory stand-in for the device's `meta` store (T-530a getMeta/setMeta); keys must start with "app." like the real one. It survives a "reopen": the test keeps the Map. */
export function fakeMeta(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const check = (k: string) => {
    if (!/^app\./.test(k)) throw new Error('meta keys must start with "app."');
  };
  return {
    store,
    getMeta: async <T>(k: string): Promise<T | null> => {
      check(k);
      await Promise.resolve();
      return (store.get(k) as T | undefined) ?? null;
    },
    setMeta: async <T>(k: string, v: T): Promise<void> => {
      check(k);
      await Promise.resolve();
      store.set(k, v);
    },
  };
}
