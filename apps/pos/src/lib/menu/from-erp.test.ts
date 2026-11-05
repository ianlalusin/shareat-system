/** T-508 S5 (R8) - the adapter mapping table: one case per mapped field. */
import { describe, expect, it } from 'vitest';
import * as erp from './from-erp';
import type { StoreMenuV2 } from '@shareat/domain';
import type { ErpMenu } from './types';
import { sampleMenu } from '@/test-helpers/menuFixture';

// Compile-time drift guard: the server's real projection type must stay assignable to the tablet's restated wire type.
export const _wireShapeMatches = (real: StoreMenuV2): ErpMenu => real;

const m = sampleMenu();

describe('adaptPackages', () => {
  const pk = erp.adaptPackages(m);
  it('one StorePackage per orderable package variant; a variant with no store price is never offered', () => {
    expect(pk.map((p) => p.packageId)).toEqual(['pk-a-lt', 'pk-a-dt', 'pk-b-v']);
  });
  it('packageId = variant id, name = item + label, price from channels.store, menuScheduleId null, enabled', () => {
    expect(pk[0]).toMatchObject({ packageName: 'Samgyup Lunch', pricePerHead: 338, menuScheduleId: null, isEnabled: true });
    expect(pk[1]).toMatchObject({ packageName: 'Samgyup Dinner', pricePerHead: 358 });
  });
  it('kitchen location from the item stationId, name from stations[]', () => {
    expect(pk[0]).toMatchObject({ kitchenLocationId: 'st-grill', kitchenLocationName: 'Grill' });
  });
  it('refillsAllowed = the variant refillItemIds', () => {
    expect(pk[0]!.refillsAllowed).toEqual(['rf-pork']);
    expect(pk[2]!.refillsAllowed).toEqual([]);
  });
  it('flavorsAllowed = orderable option values of the refill items it allows', () => {
    expect(pk[0]!.flavorsAllowed).toEqual(['fv-original', 'fv-spicy']);
  });
  it('bundle fields from bundleHeads / extraHeadAmount; a plain package has none', () => {
    expect(pk[2]).toMatchObject({ isBundle: true, bundlePrice: 999, bundleMaxCap: 4, bundleExtraHeadPrice: 250 });
    expect(pk[0]!.isBundle).toBeUndefined();
  });
});

describe('flavours, refills, global refills', () => {
  it('flavours are the option values of refill items; a value not orderable in store is left out', () => {
    expect(erp.adaptFlavors(m)).toEqual([
      { flavorId: 'fv-original', flavorName: 'Original', isEnabled: true, sortOrder: 1 },
      { flavorId: 'fv-spicy', flavorName: 'Spicy', isEnabled: true, sortOrder: 2 },
    ]);
  });
  it('store refills carry station and flavorsAllowed', () => {
    const r = erp.adaptRefills(m);
    expect(r.find((x) => x.refillId === 'rf-pork')).toMatchObject({ refillName: 'Pork refill', kitchenLocationId: 'st-grill', kitchenLocationName: 'Grill', flavorsAllowed: ['fv-original', 'fv-spicy'] });
    expect(r.find((x) => x.refillId === 'rf-rice')).toMatchObject({ kitchenLocationId: 'st-bar', flavorsAllowed: [] });
  });
  it('global refills: requiresFlavor only when the refill has flavour values', () => {
    const g = erp.adaptGlobalRefills(m);
    expect(g.find((x) => x.id === 'rf-pork')).toMatchObject({ requiresFlavor: true, allowedFlavorIds: ['fv-original', 'fv-spicy'], isActive: true });
    expect(g.find((x) => x.id === 'rf-rice')!.requiresFlavor).toBe(false);
  });
});

describe('adaptAddons (the single add-on / a-la-carte source)', () => {
  const a = erp.adaptAddons(m);
  it('soldALaCarte and soldInPackageSession items become rows with their flag; packages and refills never do', () => {
    expect(a.find((x) => x.id === 'al-1-v')).toMatchObject({ soldALaCarte: true, soldInPackageSession: false, sellingPrice: 90, isAddon: true, kitchenLocationId: 'st-bar', kitchenLocationName: 'Bar', subCategory: 'Mains' });
    expect(a.find((x) => x.id === 'al-2-s')).toMatchObject({ soldALaCarte: false, soldInPackageSession: true });
  });
  it('variants group under their item; a single unlabelled variant groups alone', () => {
    expect(a.find((x) => x.id === 'al-2-s')).toMatchObject({ groupKey: 'al-2', groupName: 'Extra lettuce', displayName: 'Extra lettuce S', sellingPrice: 20 });
    expect(a.find((x) => x.id === 'al-1-v')).toMatchObject({ groupKey: 'al-1-v', displayName: 'Soju' });
  });
});

describe('adaptKitchenLocations', () => {
  it('id, name, slaMinutes, printOnOutage from stations[]; active, in projected order', () => {
    expect(erp.adaptKitchenLocations(m)).toEqual([
      { id: 'st-grill', name: 'Grill', sortOrder: 0, isActive: true, slaMinutes: 12, printOnOutage: true },
      { id: 'st-bar', name: 'Bar', sortOrder: 1, isActive: true, slaMinutes: 5, printOnOutage: false },
    ]);
  });
});

describe('an unrouted item never appears', () => {
  it('notOnPos items are not reintroduced anywhere by the adapter', () => {
    const all = JSON.stringify([erp.adaptPackages(m), erp.adaptRefills(m), erp.adaptAddons(m), erp.adaptFlavors(m), erp.adaptKitchenLocations(m)]);
    expect(all).not.toContain('x-unrouted');
    expect(all).not.toContain('Unrouted thing');
  });
});
