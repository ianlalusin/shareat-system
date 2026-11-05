/**
 * T-510 S1b - which offers a store shows RIGHT NOW once a variant can hold several live offers (one per daypart).
 * docs/tasks/510-menu-dayparts.md R4. Pure: resolveStoreOffers takes the raw in-force rows, the store's dayparts, the instant and the zone.
 * Manila wall clock (UTC+8, no DST). 2026-11-01 is a Sunday.
 */
import { describe, expect, it } from 'vitest';
import type { menuRepo } from '@shareat/db';
import { resolveStoreOffers } from '../../src/menu/live-offers';
import type { DaypartWindow } from '../../src/menu/daypart';

type Row = menuRepo.OfferInForce;
const TZ = 'Asia/Manila';
const ALL = [0, 1, 2, 3, 4, 5, 6];
const at = (date: string, hhmm: string): Date => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};
const SUN = '2026-11-01';

const LUNCH: DaypartWindow = { id: 'L', days: ALL, start: '08:00', end: '17:00' };
const DINNER: DaypartWindow = { id: 'D', days: ALL, start: '17:00', end: '08:00' };

const FROM = new Date('2026-10-01T00:00:00Z');
let n = 0;
function row(over: Partial<Row> & Pick<Row, 'variantId' | 'channel'>): Row {
  return {
    id: `o${++n}`,
    effectiveFrom: FROM,
    daypartId: null,
    withdrawn: false,
    pricingMode: 'fixed',
    amount: '100.00',
    bundleHeads: null,
    extraHeadAmount: null,
    markupPercent: null,
    fixedMarkupAmount: null,
    basis: null,
    ...over,
  };
}
const lunchRow = (amount: string, o: Partial<Row> = {}) => row({ variantId: 'V', channel: 'store', daypartId: 'L', amount, ...o });
const dinnerRow = (amount: string, o: Partial<Row> = {}) => row({ variantId: 'V', channel: 'store', daypartId: 'D', amount, ...o });
const amounts = (r: ReturnType<typeof resolveStoreOffers>) => r.offers.map((o) => `${o.variantId}/${o.channel}=${o.amount}`);

describe('resolveStoreOffers - no dayparts in the data behaves as before', () => {
  it('returns every row untouched, one per variant and channel', () => {
    const a = row({ variantId: 'A', channel: 'store', amount: '50.00' });
    const b = row({ variantId: 'B', channel: 'store', amount: null, withdrawn: true });
    const r = resolveStoreOffers([a, b], [], at(SUN, '12:00'), TZ);
    expect(r.offers).toEqual([a, b]);
    expect(r.notOfferedNow).toEqual([]);
    expect(r.faults).toEqual([]);
  });

  it.each(['', 'Asia/Manilla'])('a bad store timezone (%j) does not touch all-day offers', (zone) => {
    const a = row({ variantId: 'A', channel: 'store', amount: '50.00' });
    const r = resolveStoreOffers([a], [], at(SUN, '12:00'), zone);
    expect(r.offers).toEqual([a]);
    expect(r.faults).toEqual([]);
  });

  it('a bad store timezone still fails a dayparted variant closed', () => {
    const r = resolveStoreOffers([lunchRow('50.00')], [LUNCH], at(SUN, '12:00'), 'Asia/Manilla');
    expect(r.offers).toEqual([]);
    expect(r.faults.map((f) => f.reason)).toEqual(['invalid_time_zone']);
  });
});

describe('resolveStoreOffers - Pork and Beef, lunch 08:00-17:00 at 338 and dinner 17:00-08:00 at 358', () => {
  const rows = [lunchRow('338.00'), dinnerRow('358.00')];
  const table: Array<[string, string, string]> = [
    ['Sun 16:59', '16:59', '338.00'],
    ['Sun 17:00', '17:00', '358.00'],
    ['Sun 07:59', '07:59', '358.00'],
    ['Sun 08:00', '08:00', '338.00'],
    ['Sun 03:00', '03:00', '358.00'],
  ];
  it.each(table)('%s picks the right price', (_l, hhmm, price) => {
    const r = resolveStoreOffers(rows, [LUNCH, DINNER], at(SUN, hhmm), TZ);
    expect(amounts(r)).toEqual([`V/store=${price}`]);
    expect(r.notOfferedNow).toEqual([]);
    expect(r.faults).toEqual([]);
  });

  it('the order of the input rows and of the dayparts never changes the answer', () => {
    const base = resolveStoreOffers(rows, [LUNCH, DINNER], at(SUN, '17:00'), TZ);
    expect(resolveStoreOffers([...rows].reverse(), [DINNER, LUNCH], at(SUN, '17:00'), TZ)).toEqual(base);
  });
});

describe('resolveStoreOffers - a window that is closed, withdrawn, or invalid', () => {
  it('only a lunch offer at 20:00: not offered now, and says when it opens', () => {
    const r = resolveStoreOffers([lunchRow('338.00')], [LUNCH], at(SUN, '20:00'), TZ);
    expect(r.offers).toEqual([]);
    expect(r.faults).toEqual([]);
    expect(r.notOfferedNow).toEqual([{ variantId: 'V', channel: 'store', availableFrom: '08:00', availableAt: at('2026-11-02', '08:00'), availableDay: 1 }]);
  });

  it('every row withdrawn: the withdrawn row is emitted, so the price still reads "withdrawn"', () => {
    const w = row({ variantId: 'V', channel: 'store', daypartId: 'L', withdrawn: true, amount: null });
    const r = resolveStoreOffers([w], [LUNCH], at(SUN, '12:00'), TZ);
    expect(r.offers).toEqual([w]);
    expect(r.notOfferedNow).toEqual([]);
  });

  it('an all-day offer next to a dayparted one is a fault and shows no price at all', () => {
    const r = resolveStoreOffers([row({ variantId: 'V', channel: 'store', amount: '300.00' }), lunchRow('338.00')], [LUNCH], at(SUN, '12:00'), TZ);
    expect(r.offers).toEqual([]);
    expect(r.faults).toEqual([{ variantId: 'V', channel: 'store', reason: 'mixed_all_day_and_daypart' }]);
  });

  it('two live windows that both hold now are a fault, never "pick one"', () => {
    const wide: DaypartWindow = { id: 'W', days: ALL, start: '10:00', end: '14:00' };
    const r = resolveStoreOffers([lunchRow('338.00'), row({ variantId: 'V', channel: 'store', daypartId: 'W', amount: '1.00' })], [LUNCH, wide], at(SUN, '12:00'), TZ);
    expect(r.offers).toEqual([]);
    expect(r.faults).toEqual([{ variantId: 'V', channel: 'store', reason: 'overlapping_dayparts' }]);
  });

  it('a fault in one variant leaves the others alone', () => {
    const ok = row({ variantId: 'A', channel: 'store', amount: '50.00' });
    const r = resolveStoreOffers([ok, row({ variantId: 'V', channel: 'store', amount: '300.00' }), lunchRow('338.00')], [LUNCH], at(SUN, '12:00'), TZ);
    expect(r.offers).toEqual([ok]);
    expect(r.faults.map((f) => f.variantId)).toEqual(['V']);
  });
});

describe('resolveStoreOffers - the online rule follows the store row that is live at this moment', () => {
  const online = (daypartId: string, mk: string) =>
    row({ variantId: 'V', channel: 'online', daypartId, pricingMode: 'percent_markup', amount: null, markupPercent: mk });
  const rows = [lunchRow('338.00'), dinnerRow('358.00'), online('L', '10.0000'), online('D', '10.0000')];

  it.each([
    ['16:59', '338.00'],
    ['17:00', '358.00'],
  ])('at %s the basis is the %s store row (the repo-side join cannot know the time)', (hhmm, base) => {
    const r = resolveStoreOffers(rows, [LUNCH, DINNER], at(SUN, hhmm), TZ);
    const o = r.offers.find((x) => x.channel === 'online')!;
    expect(o.basis?.amount).toBe(base);
    expect(o.basis?.withdrawn).toBe(false);
    expect(r.offers).toHaveLength(2);
  });

  it('the store resolved to "not offered now": the online basis is null', () => {
    const allDayOnline = row({ variantId: 'V', channel: 'online', pricingMode: 'percent_markup', amount: null, markupPercent: '10.0000' });
    const r = resolveStoreOffers([lunchRow('338.00'), allDayOnline], [LUNCH], at(SUN, '20:00'), TZ);
    expect(r.offers).toEqual([{ ...allDayOnline, basis: null }]);
    expect(r.notOfferedNow.map((x) => x.channel)).toEqual(['store']);
  });

  it('the store row was withdrawn: the basis says withdrawn', () => {
    const w = row({ variantId: 'V', channel: 'store', withdrawn: true, amount: null });
    const o = row({ variantId: 'V', channel: 'online', pricingMode: 'percent_markup', amount: null, markupPercent: '10.0000' });
    const r = resolveStoreOffers([w, o], [], at(SUN, '12:00'), TZ);
    expect(r.offers.find((x) => x.channel === 'online')!.basis?.withdrawn).toBe(true);
  });

  it('no store row at all: the basis is null', () => {
    const o = row({ variantId: 'V', channel: 'online', pricingMode: 'percent_markup', amount: null, markupPercent: '10.0000' });
    expect(resolveStoreOffers([o], [], at(SUN, '12:00'), TZ).offers).toEqual([{ ...o, basis: null }]);
  });

  it('the order of the input never changes the result', () => {
    const base = resolveStoreOffers(rows, [LUNCH, DINNER], at(SUN, '17:00'), TZ);
    expect(resolveStoreOffers([...rows].reverse(), [LUNCH, DINNER], at(SUN, '17:00'), TZ)).toEqual(base);
  });
});
