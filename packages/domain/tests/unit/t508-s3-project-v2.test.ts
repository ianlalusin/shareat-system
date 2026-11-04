/**
 * T-508 S3 (R4, R5, R11) - projection v2: live station rows, unrouted items left out, deterministic hash. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import { projectStoreMenu } from '../../src/menu/project';

const AT = new Date('2026-10-14T00:00:00.000Z');
const S = 'store-a';
const fixed = (variantId: string, channel: 'store' | 'online') => ({
  variantId, channel, effectiveFrom: new Date('2026-01-01T00:00:00Z'), basis: null,
  withdrawn: false, pricingMode: 'fixed' as const, amount: '100.00', bundleHeads: null, extraHeadAmount: null, markupPercent: null, fixedMarkupAmount: null,
});
const item = (id: string, name: string, sortOrder: number) => ({
  id, categoryId: 'c1', name, description: null, itemType: 'a_la_carte', soldALaCarte: true, soldInPackageSession: false, dinerOrderable: true, sortOrder, status: 'active',
});
const station = (id: string, name: string, sortOrder: number, status = 'active') => ({ id, storeId: S, name, slaMinutes: 12, printOnOutage: true, sortOrder, status });

function base(over: Record<string, unknown> = {}): any {
  return {
    categories: [{ id: 'c1', name: 'Mains', parentId: null, sortOrder: 1, status: 'active' }],
    items: [item('i1', 'Burger', 1), item('i2', 'Fries', 2)],
    variants: ['i1', 'i2'].map((m) => ({ id: `v-${m}`, menuItemId: m, label: null, isDefault: true, sortOrder: 1, status: 'active' })),
    optionGroups: [], optionValues: [], optionGroupLinks: [], packageRefills: [],
    stores: [{ storeId: S, at: AT, offers: [fixed('v-i1', 'store'), fixed('v-i2', 'store')], optionOffers: [], upcoming: [] }],
    stations: [station('st1', 'Grill', 1), station('st2', 'Fryer', 2)],
    routes: [{ storeId: S, menuItemId: 'i1', stationId: 'st1' }, { storeId: S, menuItemId: 'i2', stationId: 'st2' }],
    ...over,
  };
}
const proj = (snap: any) => projectStoreMenu(snap, S, AT);

describe('T-508 S3 projection v2', () => {
  it('R4: renaming a station changes the projected name AND the hash', () => {
    const a = proj(base());
    const b = proj(base({ stations: [station('st1', 'Hot Line', 1), station('st2', 'Fryer', 2)] }));
    expect(a.menu.stations.map((s) => s.name)).toEqual(['Grill', 'Fryer']);
    expect(b.menu.stations.map((s) => s.name)).toEqual(['Hot Line', 'Fryer']);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it('R5: an unrouted item is absent from items and present in notOnPos', () => {
    const p = proj(base({ routes: [{ storeId: S, menuItemId: 'i1', stationId: 'st1' }] }));
    expect(p.menu.items.map((i) => i.id)).toEqual(['i1']);
    expect(p.menu.notOnPos).toEqual([{ itemId: 'i2', name: 'Fries', reason: 'no_station' }]);
  });

  it('R5: a route to a retired station counts as no route', () => {
    const p = proj(base({ stations: [station('st1', 'Grill', 1), station('st2', 'Fryer', 2, 'retired')] }));
    expect(p.menu.items.map((i) => i.id)).toEqual(['i1']);
    expect(p.menu.notOnPos.map((n) => n.itemId)).toEqual(['i2']);
  });

  it('R2/R11: a routed item carries its stationId; a route of another store is ignored', () => {
    const p = proj(base({ routes: [{ storeId: S, menuItemId: 'i1', stationId: 'st1' }, { storeId: 'store-b', menuItemId: 'i2', stationId: 'st2' }] }));
    expect(p.menu.items.map((i) => [i.id, i.stationId])).toEqual([['i1', 'st1']]);
    expect(proj(base()).menu.items.map((i) => [i.id, i.stationId])).toEqual([['i1', 'st1'], ['i2', 'st2']]);
  });

  it('a retired station never appears in stations; stations carry id, name, slaMinutes, printOnOutage in sort order', () => {
    const p = proj(base({ stations: [station('st2', 'Fryer', 2), station('st1', 'Grill', 1), station('st3', 'Old', 0, 'retired')] }));
    expect(p.menu.stations).toEqual([
      { id: 'st1', name: 'Grill', slaMinutes: 12, printOnOutage: true },
      { id: 'st2', name: 'Fryer', slaMinutes: 12, printOnOutage: true },
    ]);
  });

  it('the hash is stable when nothing changes, and v2 is stamped', () => {
    const a = proj(base());
    expect(proj(base()).contentHash).toBe(a.contentHash);
    expect(a.menu.schemaVersion).toBe(2);
  });

  it('route order and station insertion order do not change the hash', () => {
    const snap = base();
    const shuffled = base({ routes: [...snap.routes].reverse(), stations: [...snap.stations].reverse() });
    expect(proj(shuffled).contentHash).toBe(proj(snap).contentHash);
  });

  it('a refill left out by R5 is not listed as a package refill', () => {
    const snap = base({
      items: [item('i1', 'Burger', 1), { ...item('ip', 'Unli', 2), itemType: 'package' }, { ...item('r1', 'Pork', 3), itemType: 'refill', soldALaCarte: false }],
      variants: ['i1', 'ip', 'r1'].map((m) => ({ id: `v-${m}`, menuItemId: m, label: null, isDefault: true, sortOrder: 1, status: 'active' })),
      packageRefills: [{ packageVariantId: 'v-ip', refillItemId: 'r1', status: 'active' }],
      routes: [{ storeId: S, menuItemId: 'i1', stationId: 'st1' }, { storeId: S, menuItemId: 'ip', stationId: 'st1' }],
    });
    snap.stores[0].offers = ['v-i1', 'v-ip', 'v-r1'].map((v) => fixed(v, 'store'));
    const p = proj(snap);
    expect(p.menu.items.find((i) => i.id === 'ip')!.variants[0]!.refillItemIds).toEqual([]);
    expect(p.menu.notOnPos.map((n) => n.itemId)).toEqual(['r1']);
  });
});
