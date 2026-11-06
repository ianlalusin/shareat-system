/** T-508 S5 (R8) - the adapter mapping table: one case per mapped field. */
import { describe, expect, it, vi } from 'vitest';
import * as erp from './from-erp';
import { flavorNamesOf, kitchenFlavorMap } from '@/lib/kitchen/flavor-names';
import type { StoreMenuV2 } from '@shareat/domain';
import type { ErpMenu } from './types';
import { daypartedMenu, sampleMenu } from '@/test-helpers/menuFixture';

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

// ---- T-510 S4b: the device resolves the live window from the slots and ITS clock ------------------------------------------------------
// Manila (UTC+8). 2026-11-01 is a Sunday. Fixed instants only.
const manila = (hhmm: string, date = '2026-11-01'): number => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0);
};

describe('dayparted packages: Pork and Beef 338 at 16:59, 358 at 17:00, from the same cached menu', () => {
  const dm = daypartedMenu();
  const pb = (hhmm: string) => erp.adaptPackages(dm, manila(hhmm)).find((p) => p.packageId === 'dp-pb-v');
  it('prices from the slot whose window holds now, ignoring the server-time `channels`', () => {
    expect(pb('16:59')).toMatchObject({ pricePerHead: 338, packageName: 'Pork and Beef', menuScheduleId: null, isEnabled: true });
    expect(pb('17:00')).toMatchObject({ pricePerHead: 358, packageId: 'dp-pb-v' });
    expect(pb('03:00')).toMatchObject({ pricePerHead: 358 });
    expect(pb('08:00')).toMatchObject({ pricePerHead: 338 });
    expect(pb('07:59')).toMatchObject({ pricePerHead: 358 });
  });
  it('one package, one id: the packageId is the variant id in both windows', () => {
    expect(pb('12:00')!.packageId).toBe(pb('20:00')!.packageId);
  });
  it('a window-closed package leaves `packages` and is listed with when it opens', () => {
    expect(erp.adaptPackages(dm, manila('12:00')).map((p) => p.packageId)).toContain('dp-lo-v');
    expect(erp.adaptPackages(dm, manila('20:00')).map((p) => p.packageId)).not.toContain('dp-lo-v');
    expect(erp.adaptClosedPackages(dm, manila('20:00'))).toEqual([{ packageId: 'dp-lo-v', packageName: 'Lunch only', availableFrom: '08:00' }, { packageId: 'dp-ov-v', packageName: 'Overlapping', availableFrom: '08:00' }]);
    expect(erp.adaptClosedPackages(dm, manila('12:00'))).toEqual([]);
  });
  it('bundle fields come from the live slot, not another one', () => {
    expect(erp.adaptPackages(dm, manila('12:00')).find((p) => p.packageId === 'dp-lo-v')).toMatchObject({ isBundle: true, bundlePrice: 300, bundleMaxCap: 4, bundleExtraHeadPrice: 60 });
  });
  it('fail closed: two slots that both hold now -> not offered, never either price; and not listed as "closed" either', () => {
    expect(erp.adaptPackages(dm, manila('12:00')).map((p) => p.packageId)).not.toContain('dp-ov-v');
    expect(erp.adaptClosedPackages(dm, manila('12:00')).map((c) => c.packageId)).not.toContain('dp-ov-v');
    // outside the overlap (15:00) exactly one holds
    expect(erp.adaptPackages(dm, manila('15:00')).find((p) => p.packageId === 'dp-ov-v')).toMatchObject({ pricePerHead: 100 });
  });
  it('fail closed: slots but no hours in the menu, or a slot naming an unknown window -> not offered', () => {
    const noHours = { ...dm, hours: undefined };
    expect(erp.adaptPackages(noHours, manila('12:00')).map((p) => p.packageId)).not.toContain('dp-pb-v');
    const unknown = { ...dm, hours: { ...dm.hours!, dayparts: dm.hours!.dayparts.filter((d) => d.id === 'D') } };
    expect(erp.adaptPackages(unknown, manila('12:00')).map((p) => p.packageId)).not.toContain('dp-pb-v');
  });
  it('a menu without hours or slots behaves exactly as before, whatever the clock', () => {
    for (const at of [manila('03:00'), manila('12:00'), manila('20:00')]) {
      expect(erp.adaptPackages(m, at).map((p) => [p.packageId, p.pricePerHead])).toEqual([['pk-a-lt', 338], ['pk-a-dt', 358], ['pk-b-v', 999]]);
    }
    expect(erp.adaptClosedPackages(m, manila('20:00'))).toEqual([]);
    expect(erp.adaptPackages(m).map((p) => p.packageId)).toEqual(['pk-a-lt', 'pk-a-dt', 'pk-b-v']); // `now` defaults to the clock
  });
  it('a menu from before S4b (outside_hours on the channel, no slots) still lists the closed package with its opening time', () => {
    const old = sampleMenu();
    old.items[0]!.variants[0]!.channels.store = { orderable: false, notOffered: 'outside_hours', availableFrom: '17:00' };
    expect(erp.adaptPackages(old, manila('12:00')).map((p) => p.packageId)).not.toContain('pk-a-lt');
    expect(erp.adaptClosedPackages(old, manila('12:00'))).toEqual([{ packageId: 'pk-a-lt', packageName: 'Samgyup Lunch', availableFrom: '17:00' }]);
  });
  it('when no window will ever open, the package is closed with availableFrom null (the line then omits "from")', () => {
    const dead = daypartedMenu();
    dead.hours = { ...dead.hours!, dayparts: dead.hours!.dayparts.map((d) => (d.id === 'L' ? { ...d, days: [] } : d)) };
    // L is now an invalid window: it holds nothing and never opens, so the lunch-only package is closed with no opening time
    expect(erp.adaptClosedPackages(dead, manila('20:00')).find((c) => c.packageId === 'dp-lo-v')).toEqual({ packageId: 'dp-lo-v', packageName: 'Lunch only', availableFrom: null });
  });
});

describe('dayparted add-ons and refills use the same live-slot rule', () => {
  const dm = daypartedMenu();
  it('an add-on is priced from the live slot', () => {
    const price = (hhmm: string) => erp.adaptAddons(dm, manila(hhmm)).find((a) => a.id === 'dp-al-v')?.sellingPrice;
    expect(price('16:59')).toBe(90);
    expect(price('17:00')).toBe(110);
  });
  it('refills and flavours are NOT window-gated (R5, v1): a closed-slot refill stays enabled with its flavours, all day', () => {
    for (const at of [manila('12:00'), manila('20:00')]) {
      vi.setSystemTime(at); // the refill functions take no clock: prove the answer does not move with it
      expect(erp.adaptRefills(dm).find((r) => r.refillId === 'dp-rf')).toMatchObject({ isEnabled: true, flavorsAllowed: ['fv-original', 'fv-spicy'] });
      expect(erp.adaptGlobalRefills(dm).find((r) => r.id === 'dp-rf')).toMatchObject({ isActive: true, requiresFlavor: true, allowedFlavorIds: ['fv-original', 'fv-spicy'] });
      expect(erp.adaptPackages(dm, at).find((p) => p.packageId === 'dp-pb-v')!.flavorsAllowed).toEqual(['fv-original', 'fv-spicy']);
    }
    vi.useRealTimers();
  });
  it('the kitchen badge still names a flavour whose only refill has a closed window', () => {
    const onlyClosedRefill = { ...dm, items: dm.items.filter((i) => i.id === 'dp-rf') };
    const flavors = erp.adaptFlavors(onlyClosedRefill);
    expect(kitchenFlavorMap({ flavors }, new Map()).get('fv-original')).toBe('Original');
    expect(flavorNamesOf(['fv-spicy'], kitchenFlavorMap({ flavors }, new Map()))).toEqual(['Spicy']);
  });
  it('an online-only refill (no store offer) stays enabled, as before S4b', () => {
    const online = sampleMenu();
    online.items.find((i) => i.id === 'rf-rice')!.variants[0]!.channels.store = { orderable: false, notOffered: 'no_offer' };
    expect(erp.adaptRefills(online).find((r) => r.refillId === 'rf-rice')!.isEnabled).toBe(true);
    expect(erp.adaptGlobalRefills(online).find((r) => r.id === 'rf-rice')!.isActive).toBe(true);
  });
  it('refills without slots stay enabled all day (existing behaviour)', () => {
    expect(erp.adaptRefills(m).every((r) => r.isEnabled)).toBe(true);
  });
});

describe('closedPackagesText: the one muted line under the package picker', () => {
  it('nothing closed -> no line', () => {
    expect(erp.closedPackagesText([])).toBeNull();
    expect(erp.closedPackagesText(undefined)).toBeNull();
  });
  it('names each closed package with when it opens, comma-joined; no "from" when nothing will open', () => {
    expect(erp.closedPackagesText([{ packageId: 'a', packageName: 'Pork and Beef', availableFrom: '17:00' }])).toBe('Not available now: Pork and Beef from 17:00');
    expect(erp.closedPackagesText([
      { packageId: 'a', packageName: 'Pork and Beef', availableFrom: '17:00' },
      { packageId: 'b', packageName: 'Lunch only', availableFrom: null },
    ])).toBe('Not available now: Pork and Beef from 17:00, Lunch only');
  });
});

describe('storeOfferOf: slots that carry no store row fall back to the channel (S4b audit 2)', () => {
  const noStore = { orderable: false as const, notOffered: 'no_offer' as const };
  const slot = (daypartId: string, store: unknown) => ({ daypartId, store, online: noStore });
  const live = (amount: string) => ({ orderable: true as const, amount, bundleHeads: null, extraHeadAmount: null });
  /** A menu whose one package variant has these slots and this server-time store channel. */
  const withVariant = (slots: unknown[], store: unknown) => {
    const dm = daypartedMenu();
    const base = dm.items.find((i) => i.id === 'dp-pb')!;
    dm.items = [{ ...base, id: 'x', name: 'Extra', sortOrder: 50, variants: [{ ...base.variants[0]!, id: 'x-v', refillItemIds: [], channels: { store: store as never, online: noStore }, slots: slots as never }] }];
    return dm;
  };
  const sold = (dm: ReturnType<typeof daypartedMenu>, hhmm: string) => erp.adaptPackages(dm, manila(hhmm)).find((p) => p.packageId === 'x-v');
  it('store all-day + an online-only daypart variant is sold at any hour, at the channel price', () => {
    const dm = withVariant([slot('L', noStore)], live('120.00'));
    expect(sold(dm, '12:00')).toMatchObject({ pricePerHead: 120 });
    expect(sold(dm, '20:00')).toMatchObject({ pricePerHead: 120 });
    expect(erp.adaptClosedPackages(dm, manila('20:00'))).toEqual([]);
  });
  it('slots with no store row and a channel that is not orderable: not offered, and not "closed" either', () => {
    const dm = withVariant([slot('L', noStore)], noStore);
    expect(sold(dm, '12:00')).toBeUndefined();
    expect(erp.adaptClosedPackages(dm, manila('12:00'))).toEqual([]);
  });
  it('slots with some store rows resolve among those only: a no-store slot is ignored', () => {
    const dm = withVariant([slot('D', noStore), slot('L', live('300.00'))], live('300.00'));
    expect(sold(dm, '12:00')).toMatchObject({ pricePerHead: 300 });
    expect(sold(dm, '20:00')).toBeUndefined(); // D holds but has no store row; L is closed
    expect(erp.adaptClosedPackages(dm, manila('20:00'))).toEqual([{ packageId: 'x-v', packageName: 'Extra', availableFrom: '08:00' }]);
  });
  it('store dayparted + online all-day is unchanged: the store slots decide', () => {
    const dm = withVariant([{ daypartId: 'L', store: live('300.00'), online: live('310.00') }], live('300.00'));
    expect(sold(dm, '12:00')).toMatchObject({ pricePerHead: 300 });
    expect(sold(dm, '20:00')).toBeUndefined();
  });
  it('a withdrawn store slot counts as a store row: holding it means not offered (and not "closed")', () => {
    const withdrawn = { orderable: false as const, notOffered: 'withdrawn' as const };
    const dm = withVariant([slot('L', live('300.00')), slot('D', withdrawn)], live('300.00'));
    expect(sold(dm, '20:00')).toBeUndefined();
    expect(erp.adaptClosedPackages(dm, manila('20:00'))).toEqual([]);
    expect(sold(dm, '12:00')).toMatchObject({ pricePerHead: 300 });
  });
});

describe('packageGone: the selected package left the list (S4b audit 5)', () => {
  it('true only when something is selected and it is no longer offered', () => {
    const list = [{ packageId: 'a' }, { packageId: 'b' }];
    expect(erp.packageGone('a', list)).toBe(false);
    expect(erp.packageGone('c', list)).toBe(true);
    expect(erp.packageGone(undefined, list)).toBe(false);
    expect(erp.packageGone('', list)).toBe(false);
    expect(erp.packageGone('a', [])).toBe(true);
  });
});
