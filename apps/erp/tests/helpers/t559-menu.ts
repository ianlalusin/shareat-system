/**
 * T-559 (TESTER) - a dayparted StoreMenuV2 as the snapshot carries it (T-510 S4b): `hours` (Asia/Manila, lunch 08:00-17:00, dinner 17:00-08:00) and per-variant
 * `slots`. `channels.store` is "live at fetch time" (lunch): that is exactly the stale price an offline tablet would keep after 17:00.
 * Plain data, no database. Every instant is Asia/Manila (UTC+8), Sunday 2026-11-01.
 */
import type { StoreMenuV2 } from '@shareat/domain';
import { id, IDS, MENU } from './t527-menu';

type Item = StoreMenuV2['items'][number];
type Variant = Item['variants'][number];
type Offer = Variant['channels']['store'];
const live = (amount: string | null, bundleHeads: number | null = null, extraHeadAmount: string | null = null): Offer => ({ orderable: true, amount, bundleHeads, extraHeadAmount });
const none: Offer = { orderable: false, notOffered: 'no_offer' };
const ALL = [0, 1, 2, 3, 4, 5, 6];

export const DP = {
  lunch: id(900), dinner: id(901),
  pkgDay: id(910), pkgDayV: id(911), // package: lunch 449.00, dinner 549.00
  pkgLunchOnly: id(912), pkgLunchOnlyV: id(913), // package sold at lunch only: 399.00
  dish: id(914), dishV: id(915), // a la carte: lunch 100.00, dinner 150.00
  bundle: id(916), bundleV: id(917), // bundle of 6 heads: lunch 1999.00 + 300.00 per extra head, dinner 2399.00 + 400.00
  refill: id(918), refillV: id(919), // refill with a lunch-only slot: must still be orderable at dinner (not window-gated)
} as const;

const variant = (n: string, store: Offer, slots: { daypartId: string; store: Offer }[]): Variant => ({
  id: n, label: null, isDefault: true, sortOrder: 1, channels: { store, online: none }, optionGroups: [], refillItemIds: [],
  slots: slots.map((s) => ({ ...s, online: none })),
});
const item = (idv: string, name: string, itemType: Item['itemType'], sortOrder: number, v: Variant, o: Partial<Item> = {}): Item => ({
  id: idv, categoryId: itemType === 'package' ? IDS.catPackages : itemType === 'refill' ? IDS.catRefills : IDS.catGrill, name, description: null, itemType,
  soldALaCarte: itemType === 'a_la_carte', soldInPackageSession: false, dinerOrderable: true, sortOrder, variants: [v], stationId: null, ...o,
});

export const DAYPARTED_MENU: StoreMenuV2 = {
  ...MENU,
  hours: {
    timeZone: 'Asia/Manila',
    dayparts: [
      { id: DP.lunch, days: ALL, start: '08:00', end: '17:00' },
      { id: DP.dinner, days: ALL, start: '17:00', end: '08:00' },
    ],
  },
  items: [
    item(DP.pkgDay, 'Dinner Grill', 'package', 10, variant(DP.pkgDayV, live('449.00'), [{ daypartId: DP.lunch, store: live('449.00') }, { daypartId: DP.dinner, store: live('549.00') }])),
    item(DP.pkgLunchOnly, 'Lunch Set', 'package', 11, variant(DP.pkgLunchOnlyV, live('399.00'), [{ daypartId: DP.lunch, store: live('399.00') }])),
    item(DP.dish, 'Pork special', 'a_la_carte', 10, variant(DP.dishV, live('100.00'), [{ daypartId: DP.lunch, store: live('100.00') }, { daypartId: DP.dinner, store: live('150.00') }])),
    item(DP.bundle, 'Party Bundle', 'package', 12, variant(DP.bundleV, live('1999.00', 6, '300.00'), [
      { daypartId: DP.lunch, store: live('1999.00', 6, '300.00') }, { daypartId: DP.dinner, store: live('2399.00', 6, '400.00') },
    ])),
    item(DP.refill, 'Rice refill (dayparted)', 'refill', 10, variant(DP.refillV, live(null), [{ daypartId: DP.lunch, store: live(null) }])),
  ],
};

/** An instant in Manila local time, 2026-11-01 unless `date` is given. */
export const manila = (hhmm: string, date = '2026-11-01'): Date => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};
