/**
 * T-527 (TESTER) - one hand-built StoreMenuV2 and snapshot for the Orders unit tests. Plain data, no database. The shapes follow
 * packages/domain/src/menu/project.ts (StoreMenuV2, ChannelOffer, ChannelDelta) and packages/domain/src/pos/snapshot.ts (`stands`).
 */
import type { StoreMenuV2 } from '@shareat/domain';

export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const STORE = id(1);
export const PERSON = id(2);
export const NOW_ISO = '2026-11-07T10:30:00.000Z';

type Item = StoreMenuV2['items'][number];
type Variant = Item['variants'][number];
type Offer = Variant['channels']['store'];
const live = (amount: string | null): Offer => ({ orderable: true, amount, bundleHeads: null, extraHeadAmount: null });
const withdrawn: Offer = { orderable: false, notOffered: 'withdrawn' };
const notSold: Offer = { orderable: false, notOffered: 'no_offer' };
const afterFive: Offer = { orderable: false, notOffered: 'outside_hours', availableFrom: '17:00' };

const variant = (n: number, store: Offer, o: Partial<Variant> = {}): Variant => ({
  id: id(n), label: null, isDefault: true, sortOrder: 1, channels: { store, online: notSold }, optionGroups: [], refillItemIds: [], ...o,
});
const delta = (priceDelta: string) => ({ store: { orderable: true as const, priceDelta }, online: { orderable: false as const, notOffered: 'no_offer' as const } });

export const IDS = {
  catPackages: id(10), catGrill: id(11), catDrinks: id(12), catRefills: id(13),
  unli: id(20), unliV: id(21),
  pork: id(22), porkV: id(23), sauceGroup: id(24), spicy: id(25), garlic: id(26),
  cola: id(27), colaV: id(28),
  samgyup: id(29), samgyupV: id(30),
  rice: id(31), riceV: id(32),
  extraRice: id(33), extraRiceV: id(34),
  dessert: id(35), dessertV: id(36),
  notHere: id(37), notHereV: id(38),
  soda: id(39), sodaSmallV: id(40), sodaLargeV: id(41),
  plain: id(42), plainV: id(43),
  addOns: id(44), addOnsGroup: id(45), addA: id(46), addB: id(47), addC: id(48), addOnsV: id(49),
  stand4: id(50), stand5: id(51), stand7: id(52),
} as const;

const item = (idv: string, categoryId: string, name: string, itemType: Item['itemType'], sortOrder: number, variants: Variant[], o: Partial<Item> = {}): Item => ({
  id: idv, categoryId, name, description: null, itemType, soldALaCarte: true, soldInPackageSession: false, dinerOrderable: true, sortOrder, variants, stationId: null, ...o,
});

/** Categories: Packages(1) Grill(2) Drinks(3) Refills(4). The lists are OUT of sort order on purpose: the picker must sort. */
export const MENU: StoreMenuV2 = {
  schemaVersion: 2,
  storeId: STORE,
  stations: [],
  categories: [
    { id: IDS.catDrinks, name: 'Drinks', parentId: null, sortOrder: 3 },
    { id: IDS.catPackages, name: 'Packages', parentId: null, sortOrder: 1 },
    { id: IDS.catRefills, name: 'Refills', parentId: null, sortOrder: 4 },
    { id: IDS.catGrill, name: 'Grill', parentId: null, sortOrder: 2 },
  ],
  items: [
    item(IDS.cola, IDS.catDrinks, 'Cola', 'a_la_carte', 1, [variant(28, withdrawn)]),
    item(IDS.unli, IDS.catPackages, 'Unli Grill', 'package', 1, [variant(21, live('449.00'))], { soldALaCarte: false }), // as catalog.ts defaults a package: not sold by itself
    item(IDS.samgyup, IDS.catGrill, 'Samgyup set', 'a_la_carte', 2, [variant(30, afterFive)]),
    item(IDS.pork, IDS.catGrill, 'Pork belly', 'a_la_carte', 1, [
      variant(23, live('250.00'), {
        optionGroups: [
          {
            id: IDS.sauceGroup, name: 'Sauce', selectionMode: 'single', minSelections: 1, maxSelections: 1,
            values: [
              { id: IDS.spicy, name: 'Spicy', sortOrder: 1, channels: delta('10.00') },
              { id: IDS.garlic, name: 'Garlic', sortOrder: 2, channels: delta('0.00') },
            ],
          },
        ],
      }),
    ]),
    item(IDS.rice, IDS.catRefills, 'Rice refill', 'refill', 1, [variant(32, live(null))]), // soldALaCarte is TRUE on purpose: the TYPE hides it
    item(IDS.extraRice, IDS.catGrill, 'Extra rice', 'a_la_carte', 3, [variant(34, live('30.00'))], { soldALaCarte: false, soldInPackageSession: true }),
    item(IDS.dessert, IDS.catDrinks, 'Halo-halo', 'a_la_carte', 2, [variant(36, live('120.00'))], { soldALaCarte: false, soldInPackageSession: false }),
    item(IDS.notHere, IDS.catDrinks, 'Not sold here', 'a_la_carte', 3, [variant(38, notSold)]),
    item(IDS.soda, IDS.catDrinks, 'Soda', 'a_la_carte', 4, [
      variant(40, live('50.00'), { label: 'Small', sortOrder: 1 }),
      variant(41, live('70.00'), { label: 'Large', isDefault: false, sortOrder: 2 }),
    ]),
    item(IDS.plain, IDS.catGrill, 'Plain rice', 'a_la_carte', 4, [variant(43, live('40.00'))]),
    item(IDS.addOns, IDS.catGrill, 'Add-on plate', 'a_la_carte', 5, [
      variant(49, live('100.00'), {
        optionGroups: [
          {
            id: IDS.addOnsGroup, name: 'Extras', selectionMode: 'multi', minSelections: 0, maxSelections: 2,
            values: [IDS.addA, IDS.addB, IDS.addC].map((vid, i) => ({ id: vid, name: `Extra ${i + 1}`, sortOrder: i + 1, channels: delta('5.00') })),
          },
        ],
      }),
    ]),
  ],
  notOnPos: [],
};

export const STANDS = [
  { id: IDS.stand7, number: 7 },
  { id: IDS.stand4, number: 4 },
  { id: IDS.stand5, number: 5 },
];

export const SNAPSHOT = { stands: STANDS, menu: MENU };
