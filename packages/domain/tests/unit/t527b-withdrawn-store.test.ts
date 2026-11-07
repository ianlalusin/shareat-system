/**
 * T-527b (row 307) - a sold-out dish (store offer withdrawn) must reach the POS tablet greyed, and must NOT change anything else.
 * `showWithdrawnStore` is the POS snapshot's switch; the default projection (server pricing, terminal feed, hashes) is untouched. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import { projectStoreMenu } from '../../src/menu/project';

const AT = new Date('2026-11-07T00:00:00.000Z');
const S = 'store-a';
const offer = (variantId: string, withdrawn: boolean) => ({
  variantId, channel: 'store' as const, effectiveFrom: new Date('2026-01-01T00:00:00Z'), basis: null,
  withdrawn, pricingMode: 'fixed' as const, amount: withdrawn ? null : '100.00', bundleHeads: null, extraHeadAmount: null, markupPercent: null, fixedMarkupAmount: null,
});
const item = (id: string, name: string, sortOrder: number) => ({
  id, categoryId: 'c1', name, description: null, itemType: 'a_la_carte', soldALaCarte: true, soldInPackageSession: false, dinerOrderable: true, sortOrder, status: 'active',
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snap = (): any => ({
  categories: [{ id: 'c1', name: 'Mains', parentId: null, sortOrder: 1, status: 'active' }],
  items: [item('i1', 'Burger', 1), item('i2', 'Bulgogi', 2)],
  variants: ['i1', 'i2'].map((m) => ({ id: `v-${m}`, menuItemId: m, label: null, isDefault: true, sortOrder: 1, status: 'active' })),
  optionGroups: [], optionValues: [], optionGroupLinks: [], packageRefills: [],
  stores: [{ storeId: S, at: AT, offers: [offer('v-i1', false), offer('v-i2', true)], optionOffers: [], upcoming: [] }], // Bulgogi: withdrawn, store only (the ERP's sold-out)
  stations: [{ id: 'st1', storeId: S, name: 'Grill', slaMinutes: 12, printOnOutage: true, sortOrder: 1, status: 'active' }],
  routes: [{ storeId: S, menuItemId: 'i1', stationId: 'st1' }, { storeId: S, menuItemId: 'i2', stationId: 'st1' }],
});

describe('T-527b showWithdrawnStore', () => {
  it('on: the withdrawn item stays in items with store = withdrawn, and is not on the not-on-POS list', () => {
    const m = projectStoreMenu(snap(), S, AT, { showWithdrawnStore: true }).menu;
    expect(m.items.map((i) => i.name)).toEqual(['Burger', 'Bulgogi']);
    expect(m.items[1]!.variants[0]!.channels.store).toEqual({ orderable: false, notOffered: 'withdrawn' });
    expect(m.notOnPos).toEqual([]);
  });

  it('off (the default every other caller uses): the withdrawn item is left out exactly as before, and the hash is unchanged', () => {
    const plain = projectStoreMenu(snap(), S, AT);
    expect(plain.menu.items.map((i) => i.name)).toEqual(['Burger']);
    expect(projectStoreMenu(snap(), S, AT, {}).contentHash).toBe(plain.contentHash);
  });

  it('on, with nothing withdrawn: the menu and its hash are identical to off', () => {
    const s = snap();
    s.stores[0].offers = [offer('v-i1', false), offer('v-i2', false)];
    expect(projectStoreMenu(s, S, AT, { showWithdrawnStore: true }).contentHash).toBe(projectStoreMenu(s, S, AT).contentHash);
  });
});
