/**
 * T-510 S4 - the store menu knows about hours (pure). docs/tasks/510-menu-dayparts.md R4, R6.
 * `resolveStoreOffers.nextBoundaryAt` and the projection's `outside_hours` / `nextChangeAt`. Manila wall clock (UTC+8, no DST).
 * 2026-11-01 is a Sunday. Every instant is passed in; nothing reads the clock.
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
const MON = '2026-11-02';

const LUNCH: DaypartWindow = { id: 'L', days: ALL, start: '08:00', end: '17:00' };
const DINNER: DaypartWindow = { id: 'D', days: ALL, start: '17:00', end: '08:00' };
const FROM = new Date('2026-10-01T00:00:00Z');
let n = 0;
const row = (over: Partial<Row> & Pick<Row, 'variantId' | 'channel'>): Row => ({
  id: `o${++n}`, effectiveFrom: FROM, daypartId: null, withdrawn: false, pricingMode: 'fixed', amount: '100.00',
  bundleHeads: null, extraHeadAmount: null, markupPercent: null, fixedMarkupAmount: null, basis: null, ...over,
});
const lunchRow = (amount: string, variantId = 'V') => row({ variantId, channel: 'store', daypartId: 'L', amount });
const dinnerRow = (amount: string, variantId = 'V') => row({ variantId, channel: 'store', daypartId: 'D', amount });

describe('resolveStoreOffers.nextBoundaryAt', () => {
  const both = [lunchRow('338.00'), dinnerRow('358.00')];
  it.each<[string, string, Date]>([
    ['Sun 16:59 -> 17:00 the same day', '16:59', manila(SUN, '17:00')],
    ['Sun 17:00 -> the next 08:00 (strictly after now)', '17:00', manila(MON, '08:00')],
    ['Sun 07:59 -> 08:00', '07:59', manila(SUN, '08:00')],
    ['Sun 03:00, inside the overnight window -> 08:00', '03:00', manila(SUN, '08:00')],
    ['Sun 20:00 -> next 08:00', '20:00', manila(MON, '08:00')],
  ])('%s', (_l, hhmm, expected) => {
    expect(resolveStoreOffers(both, [LUNCH, DINNER], manila(SUN, hhmm), TZ).nextBoundaryAt).toEqual(expected);
  });

  it('a window no live offer uses causes no boundary', () => {
    const unused: DaypartWindow = { id: 'X', days: ALL, start: '13:00', end: '14:00' };
    const r = resolveStoreOffers([lunchRow('338.00')], [LUNCH, unused], manila(SUN, '12:00'), TZ);
    expect(r.nextBoundaryAt).toEqual(manila(SUN, '17:00'));
  });

  it('a withdrawn dayparted row does not count, so its window causes no boundary', () => {
    const w = row({ variantId: 'V', channel: 'store', daypartId: 'D', withdrawn: true, amount: null });
    const r = resolveStoreOffers([lunchRow('338.00'), w], [LUNCH, DINNER], manila(SUN, '12:00'), TZ);
    expect(r.nextBoundaryAt).toEqual(manila(SUN, '17:00'));
    expect(resolveStoreOffers([w], [DINNER], manila(SUN, '12:00'), TZ).nextBoundaryAt).toBeNull();
  });

  it('no dayparted rows -> null (all-day offers, or no rows at all)', () => {
    expect(resolveStoreOffers([row({ variantId: 'A', channel: 'store' })], [LUNCH, DINNER], manila(SUN, '12:00'), TZ).nextBoundaryAt).toBeNull();
    expect(resolveStoreOffers([], [], manila(SUN, '12:00'), TZ).nextBoundaryAt).toBeNull();
  });

  it.each(['', 'Asia/Manilla'])('a bad store timezone (%j) -> null', (zone) => {
    expect(resolveStoreOffers(both, [LUNCH, DINNER], manila(SUN, '12:00'), zone).nextBoundaryAt).toBeNull();
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
/** What loadStoreMenu does, minus the database: resolve the raw rows at `at`, then project. */
function project(rows: Row[], windows: DaypartWindow[], at: Date, upcoming: Date[] = []) {
  const live = resolveStoreOffers(rows, windows, at, TZ);
  const snap: MenuSnapshot = {
    ...catalog(),
    stores: [{ storeId: S, at, offers: live.offers, optionOffers: [], upcoming, notOfferedNow: live.notOfferedNow, nextDaypartBoundary: live.nextBoundaryAt }],
  };
  return projectStoreMenu(snap, S, at);
}
const storeChannel = (p: ReturnType<typeof project>) => p.menu.items[0]?.variants[0]?.channels.store;

describe('projectStoreMenu - hours', () => {
  const both = [lunchRow('338.00'), dinnerRow('358.00')];

  it('a lunch-only package at 20:00 still appears, outside_hours, with the HH:MM it opens (no date)', () => {
    const p = project([lunchRow('338.00')], [LUNCH], manila(SUN, '20:00'));
    expect(storeChannel(p)).toEqual({ orderable: false, notOffered: 'outside_hours', availableFrom: '08:00' });
    expect(p.menu.items.map((i) => i.id)).toEqual(['i1']);
    expect(p.menu.items[0]!.stationId).toBe('st1');
  });

  it('an outside_hours store item with no station is left out and listed (R5 still holds)', () => {
    const live = resolveStoreOffers([lunchRow('338.00')], [LUNCH], manila(SUN, '20:00'), TZ);
    const snap: MenuSnapshot = { ...catalog(), routes: [], stores: [{ storeId: S, at: manila(SUN, '20:00'), offers: live.offers, optionOffers: [], upcoming: [], notOfferedNow: live.notOfferedNow }] };
    const p = projectStoreMenu(snap, S, manila(SUN, '20:00'));
    expect(p.menu.items).toEqual([]);
    expect(p.menu.notOnPos).toEqual([{ itemId: 'i1', name: 'Pork and Beef', reason: 'no_station' }]);
  });

  it('the live window serves its price: 338 at 16:59, 358 at 17:00', () => {
    expect(storeChannel(project(both, [LUNCH, DINNER], manila(SUN, '16:59')))).toMatchObject({ orderable: true, amount: '338.00' });
    expect(storeChannel(project(both, [LUNCH, DINNER], manila(SUN, '17:00')))).toMatchObject({ orderable: true, amount: '358.00' });
  });

  it('nextChangeAt is the daypart boundary when nothing else is coming', () => {
    expect(project(both, [LUNCH, DINNER], manila(SUN, '16:59')).nextChangeAt).toBe(manila(SUN, '17:00').toISOString());
  });

  it('nextChangeAt is the earlier of the upcoming offer date and the boundary, both ways round', () => {
    const at = manila(SUN, '16:30');
    const sooner = manila(SUN, '16:45');
    const later = manila(MON, '12:00');
    expect(project(both, [LUNCH, DINNER], at, [sooner]).nextChangeAt).toBe(sooner.toISOString());
    expect(project(both, [LUNCH, DINNER], at, [later]).nextChangeAt).toBe(manila(SUN, '17:00').toISOString());
  });

  it('an upcoming date at exactly the boundary, or at/before now, never produces a nextChangeAt in the past', () => {
    const at = manila(SUN, '17:00');
    const p = project(both, [LUNCH, DINNER], at, [at, new Date(at.getTime() - 1000)]);
    expect(p.nextChangeAt).toBe(manila(MON, '08:00').toISOString());
  });

  it('the hash is identical at 10:00 and 15:00 (same window) and differs at 17:00', () => {
    const h = (hhmm: string) => project(both, [LUNCH, DINNER], manila(SUN, hhmm)).contentHash;
    expect(h('10:00')).toBe(h('15:00'));
    expect(h('17:00')).not.toBe(h('15:00'));
    // closed-window shape is stable all evening too, and it carries no date
    const closed = (hhmm: string) => project([lunchRow('338.00')], [LUNCH], manila(SUN, hhmm)).contentHash;
    expect(closed('18:00')).toBe(closed('23:30'));
    expect(closed('18:00')).toBe(project([lunchRow('338.00')], [LUNCH], manila(MON, '03:00')).contentHash);
  });

  it('no dayparts in the data: output is byte-identical with and without the new fields', () => {
    const at = manila(SUN, '12:00');
    const plain = row({ variantId: 'V', channel: 'store', amount: '120.00' });
    const without: MenuSnapshot = { ...catalog(), stores: [{ storeId: S, at, offers: [plain], optionOffers: [], upcoming: [manila(MON, '09:00')] }] };
    const live = resolveStoreOffers([plain], [], at, TZ);
    const withNew: MenuSnapshot = {
      ...catalog(),
      stores: [{ storeId: S, at, offers: live.offers, optionOffers: [], upcoming: [manila(MON, '09:00')], notOfferedNow: live.notOfferedNow, nextDaypartBoundary: live.nextBoundaryAt }],
    };
    const a = projectStoreMenu(without, S, at);
    const b = projectStoreMenu(withNew, S, at);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.nextChangeAt).toBe(manila(MON, '09:00').toISOString());
  });
});
