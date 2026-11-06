/**
 * T-510 S4b - the store menu carries the hours and every priced slot, so the tablet can pick the live window offline (pure).
 * docs/tasks/510-menu-dayparts.md R4-R6, S4b. `resolveStoreOffers.{hours,slots}` and the projection's `hours` / per-variant `slots`.
 * Manila wall clock (UTC+8, no DST). 2026-11-01 is a Sunday. Every instant is passed in; nothing reads the clock.
 */
import { describe, expect, it } from 'vitest';
import type { menuRepo } from '@shareat/db';
import { resolveStoreOffers } from '../../src/menu/live-offers';
import { projectStoreMenu, type MenuSnapshot } from '../../src/menu/project';
import type { DaypartWindow } from '../../src/menu/daypart';

type Row = menuRepo.OfferInForce;
const TZ = 'Asia/Manila';
const ALL = [0, 1, 2, 3, 4, 5, 6];
const manila = (date: string, hhmm: string): Date => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};
const SUN = '2026-11-01';

const LUNCH: DaypartWindow = { id: 'L', days: ALL, start: '08:00', end: '17:00' };
const DINNER: DaypartWindow = { id: 'D', days: ALL, start: '17:00', end: '08:00' };
const FROM = new Date('2026-10-01T00:00:00Z');
let n = 0;
const row = (over: Partial<Row> & Pick<Row, 'variantId' | 'channel'>): Row => ({
  id: `o${++n}`, effectiveFrom: FROM, daypartId: null, withdrawn: false, pricingMode: 'fixed', amount: '100.00',
  bundleHeads: null, extraHeadAmount: null, markupPercent: null, fixedMarkupAmount: null, basis: null, ...over,
});
const lunch = (amount: string, variantId = 'V') => row({ variantId, channel: 'store', daypartId: 'L', amount });
const dinner = (amount: string, variantId = 'V') => row({ variantId, channel: 'store', daypartId: 'D', amount });
const BOTH = [lunch('338.00'), dinner('358.00')];

describe('resolveStoreOffers.slots / hours', () => {
  const live = (rows: Row[], windows: DaypartWindow[], hhmm = '12:00') => resolveStoreOffers(rows, windows, manila(SUN, hhmm), TZ);

  it('every standing dayparted row is a slot, whatever the time; hours are the windows they use, sorted by id', () => {
    for (const hhmm of ['12:00', '20:00']) {
      const r = live(BOTH, [LUNCH, DINNER], hhmm);
      expect(r.slots.map((s) => s.daypartId)).toEqual(['D', 'L']);
      expect(r.hours).toEqual({ timeZone: TZ, dayparts: [DINNER, LUNCH] });
    }
  });
  it('a window no standing offer uses is not in hours', () => {
    const unused: DaypartWindow = { id: 'X', days: ALL, start: '13:00', end: '14:00' };
    expect(live([lunch('338.00')], [LUNCH, DINNER, unused]).hours!.dayparts.map((d) => d.id)).toEqual(['L']);
  });
  it('a withdrawn dayparted row is not a slot and its window is not in hours', () => {
    const w = row({ variantId: 'V', channel: 'store', daypartId: 'D', withdrawn: true, amount: null });
    const r = live([lunch('338.00'), w], [LUNCH, DINNER]);
    expect(r.slots.map((s) => s.daypartId)).toEqual(['L']);
    expect(r.hours!.dayparts.map((d) => d.id)).toEqual(['L']);
  });
  it('no dayparted rows -> no slots, hours null', () => {
    const r = live([row({ variantId: 'A', channel: 'store' })], [LUNCH, DINNER]);
    expect(r.slots).toEqual([]);
    expect(r.hours).toBeNull();
  });
  it('a variant whose offers fault (overlap, unknown daypart, mixed all-day) contributes no slots, and neither does its window', () => {
    const overlapA: DaypartWindow = { id: 'A', days: ALL, start: '10:00', end: '14:00' };
    const overlapB: DaypartWindow = { id: 'B', days: ALL, start: '12:00', end: '16:00' };
    const rows = [
      row({ variantId: 'OV', channel: 'store', daypartId: 'A' }), row({ variantId: 'OV', channel: 'store', daypartId: 'B' }), // both hold 12:00
      row({ variantId: 'UN', channel: 'store', daypartId: 'GONE' }),
      row({ variantId: 'MX', channel: 'store' }), row({ variantId: 'MX', channel: 'store', daypartId: 'L' }),
      lunch('338.00', 'OK'),
    ];
    const r = live(rows, [LUNCH, overlapA, overlapB]);
    expect(r.faults.map((f) => f.variantId).sort()).toEqual(['MX', 'OV', 'UN']);
    expect(r.slots.map((s) => s.variantId)).toEqual(['OK']);
    expect(r.hours!.dayparts.map((d) => d.id)).toEqual(['L']);
  });
  it('a bad store timezone -> no slots (a dayparted variant faults), hours null', () => {
    const r = resolveStoreOffers(BOTH, [LUNCH, DINNER], manila(SUN, '12:00'), 'Asia/Manilla');
    expect(r.slots).toEqual([]);
    expect(r.hours).toBeNull();
  });
  it('slot order is stable: variant, channel, daypart, whatever the input order', () => {
    const rows = [dinner('358.00', 'B'), lunch('338.00', 'B'), dinner('1.00', 'A'), lunch('2.00', 'A')];
    const a = live(rows, [LUNCH, DINNER]).slots.map((s) => `${s.variantId}${s.daypartId}`);
    const b = live([...rows].reverse(), [DINNER, LUNCH]).slots.map((s) => `${s.variantId}${s.daypartId}`);
    expect(a).toEqual(['AD', 'AL', 'BD', 'BL']);
    expect(b).toEqual(a);
  });
});

// ---- projection --------------------------------------------------------------------------------------------------------
const S = 'store-a';
const catalog = (): Omit<MenuSnapshot, 'stores'> => ({
  categories: [{ id: 'c1', name: 'Packages', parentId: null, sortOrder: 1, status: 'active' }],
  items: [{ id: 'i1', categoryId: 'c1', name: 'Pork and Beef', description: null, itemType: 'package', soldALaCarte: false, soldInPackageSession: false, dinerOrderable: true, sortOrder: 1, status: 'active' }],
  variants: [{ id: 'V', menuItemId: 'i1', label: null, isDefault: true, sortOrder: 1, status: 'active' }],
  optionGroups: [], optionValues: [], optionGroupLinks: [], packageRefills: [],
  stations: [{ id: 'st1', storeId: S, name: 'Grill', slaMinutes: 12, printOnOutage: true, sortOrder: 1, status: 'active' }],
  routes: [{ storeId: S, menuItemId: 'i1', stationId: 'st1' }],
});
/** What loadStoreMenu does, minus the database. */
function project(rows: Row[], windows: DaypartWindow[], at: Date, cat: Omit<MenuSnapshot, 'stores'> = catalog()) {
  const live = resolveStoreOffers(rows, windows, at, TZ);
  const snap: MenuSnapshot = {
    ...cat,
    stores: [{ storeId: S, at, offers: live.offers, optionOffers: [], upcoming: [], notOfferedNow: live.notOfferedNow, nextDaypartBoundary: live.nextBoundaryAt, hours: live.hours ?? undefined, slots: live.slots }],
  };
  return projectStoreMenu(snap, S, at);
}
const variant = (p: ReturnType<typeof project>) => p.menu.items[0]!.variants[0]!;

describe('projectStoreMenu - slots and hours', () => {
  it('a dayparted variant carries both slots priced, sorted by daypart id; channels stay "live now"', () => {
    const p = project(BOTH, [LUNCH, DINNER], manila(SUN, '16:59'));
    expect(variant(p).slots).toEqual([
      { daypartId: 'D', store: { orderable: true, amount: '358.00', bundleHeads: null, extraHeadAmount: null }, online: { orderable: false, notOffered: 'no_offer' } },
      { daypartId: 'L', store: { orderable: true, amount: '338.00', bundleHeads: null, extraHeadAmount: null }, online: { orderable: false, notOffered: 'no_offer' } },
    ]);
    expect(variant(p).channels.store).toMatchObject({ orderable: true, amount: '338.00' });
    expect(p.menu.hours).toEqual({ timeZone: TZ, dayparts: [DINNER, LUNCH] });
  });
  it('the slots are the same at 16:59 and 17:00; only channels (and so the hash) move', () => {
    const a = project(BOTH, [LUNCH, DINNER], manila(SUN, '16:59'));
    const b = project(BOTH, [LUNCH, DINNER], manila(SUN, '17:00'));
    expect(variant(b).slots).toEqual(variant(a).slots);
    expect(b.menu.hours).toEqual(a.menu.hours);
    expect(variant(b).channels.store).toMatchObject({ amount: '358.00' });
  });
  it('a closed-window variant still carries its slots (the tablet needs them offline)', () => {
    const p = project([lunch('338.00')], [LUNCH], manila(SUN, '20:00'));
    expect(variant(p).channels.store).toEqual({ orderable: false, notOffered: 'outside_hours', availableFrom: '08:00' });
    expect(variant(p).slots!.map((s) => s.daypartId)).toEqual(['L']);
  });
  it('an online rule is priced from the SAME slot basis, per slot', () => {
    const rule = (daypartId: string, basis: Row) => row({ variantId: 'V', channel: 'online', daypartId, pricingMode: 'percent_markup', amount: null, markupPercent: '10.0000', basis });
    const rows = [lunch('338.00'), dinner('358.00')];
    const rules = [rule('L', rows[0]!), rule('D', rows[1]!)];
    const p = project([...rows, ...rules], [LUNCH, DINNER], manila(SUN, '12:00'));
    const slots = variant(p).slots!;
    expect(slots.map((s) => s.online)).toEqual([
      { orderable: true, amount: '393.80', bundleHeads: null, extraHeadAmount: null },
      { orderable: true, amount: '371.80', bundleHeads: null, extraHeadAmount: null },
    ]);
  });
  it('no dayparts: no hours key, no slots key, output byte-identical to a snapshot without the new fields', () => {
    const at = manila(SUN, '12:00');
    const plain = row({ variantId: 'V', channel: 'store', amount: '120.00' });
    const live = resolveStoreOffers([plain], [], at, TZ);
    const without: MenuSnapshot = { ...catalog(), stores: [{ storeId: S, at, offers: [plain], optionOffers: [], upcoming: [] }] };
    const withNew: MenuSnapshot = { ...catalog(), stores: [{ storeId: S, at, offers: live.offers, optionOffers: [], upcoming: [], notOfferedNow: live.notOfferedNow, nextDaypartBoundary: live.nextBoundaryAt, hours: live.hours ?? undefined, slots: live.slots }] };
    const a = projectStoreMenu(without, S, at);
    const b = projectStoreMenu(withNew, S, at);
    expect('hours' in b.menu).toBe(false);
    expect('slots' in b.menu.items[0]!.variants[0]!).toBe(false);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('slots of a variant that does not appear (retired) leave no trace, and hours drop with them', () => {
    const cat = { ...catalog(), variants: [{ id: 'V', menuItemId: 'i1', label: null, isDefault: true, sortOrder: 1, status: 'retired' as const }] };
    const p = project(BOTH, [LUNCH, DINNER], manila(SUN, '12:00'), cat);
    expect(p.menu.items).toEqual([]);
    expect('hours' in p.menu).toBe(false);
  });
  it('hours list only windows an appearing variant uses', () => {
    const base = catalog();
    const cat = { ...base, variants: [...base.variants, { id: 'W', menuItemId: 'i1', label: 'Late', isDefault: false, sortOrder: 2, status: 'retired' as const }] };
    const p = project([lunch('338.00'), dinner('358.00', 'W')], [LUNCH, DINNER], manila(SUN, '12:00'), cat);
    expect(p.menu.hours!.dayparts.map((d) => d.id)).toEqual(['L']);
  });
  it('the hash covers hours and slots: a price in a closed slot, or a window edit, changes it even when channels do not', () => {
    const at = manila(SUN, '12:00');
    const base = project(BOTH, [LUNCH, DINNER], at).contentHash;
    expect(project([lunch('338.00'), dinner('359.00')], [LUNCH, DINNER], at).contentHash).not.toBe(base);
    expect(project(BOTH, [LUNCH, { ...DINNER, start: '17:30' }], at).contentHash).not.toBe(base);
    expect(project(BOTH, [LUNCH, { ...DINNER, days: [0, 1, 2, 3, 4, 5] }], at).contentHash).not.toBe(base);
    // the same data at a different instant inside the same window hashes the same
    expect(project(BOTH, [LUNCH, DINNER], manila(SUN, '15:00')).contentHash).toBe(base);
  });
  it('days are stored sorted, so an unsorted source hashes the same as a sorted one', () => {
    const at = manila(SUN, '12:00');
    const unsorted = project(BOTH, [LUNCH, { ...DINNER, days: [6, 0, 5, 1, 4, 2, 3] }], at);
    expect(unsorted.contentHash).toBe(project(BOTH, [LUNCH, DINNER], at).contentHash);
    expect(unsorted.menu.hours!.dayparts[0]!.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
