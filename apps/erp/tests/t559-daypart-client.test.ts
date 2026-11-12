/**
 * T-559 R1 (TESTER, written before the code) - the tablet's copy of the daypart window logic and the slot resolver.
 * docs/tasks/559-pos-offline-daypart-switch.md R1, R4. The copy lives in apps/erp/src/lib/pos-device/daypart-client.ts (NO imports from @shareat/*).
 * PARITY: one table of instants x windows x zones goes through the copy AND the domain's daypart.ts. A test may import the domain; the copy may not.
 * Manila is UTC+8 with no daylight saving; 2026-11-01 is a Sunday.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { daypartContains, nextDaypartBoundary, resolveLiveOffer, type DaypartWindow } from '../../../packages/domain/src/menu/daypart';
import { contains, nextBoundary, nextOpening, resolveSlot } from '../src/lib/pos-device/daypart-client';

const ALL = [0, 1, 2, 3, 4, 5, 6];
const WINDOWS: Record<string, DaypartWindow> = {
  lunch: { id: 'lunch', days: ALL, start: '08:00', end: '17:00' },
  dinner: { id: 'dinner', days: ALL, start: '17:00', end: '08:00' },
  weekdayMorning: { id: 'wk', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  sundayLate: { id: 'sl', days: [0], start: '22:00', end: '02:00' },
  satToSun: { id: 'ss', days: [6], start: '23:30', end: '00:30' },
  nyEarly: { id: 'ny', days: ALL, start: '01:30', end: '03:30' },
  endEqualsStart: { id: 'bad1', days: ALL, start: '10:00', end: '10:00' },
  badTime: { id: 'bad2', days: ALL, start: '25:00', end: '10:00' },
  noDays: { id: 'bad3', days: [], start: '10:00', end: '11:00' },
};
const manila = (date: string, hhmm: string): Date => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};
const sweep = (fromIso: string, count: number, stepMin: number): Date[] => Array.from({ length: count }, (_, i) => new Date(Date.parse(fromIso) + i * stepMin * 60_000));
const MANILA_INSTANTS = [
  ...['03:00', '07:59', '08:00', '16:59', '17:00', '00:00', '23:59'].map((t) => manila('2026-11-01', t)),
  ...['00:30', '01:59', '02:00', '09:00', '11:59', '12:00', '23:30'].map((t) => manila('2026-11-02', t)),
];
const NY_INSTANTS = [...sweep('2026-03-08T04:00:00Z', 24, 15), ...sweep('2026-11-01T04:30:00Z', 32, 15)];
const WEEK = sweep('2026-11-01T00:00:00Z', 170, 61);
const ZONES: Array<[string, Date[]]> = [
  ['Asia/Manila', [...MANILA_INSTANTS, ...WEEK]],
  ['America/New_York', [...NY_INSTANTS, ...WEEK]],
  ['Pacific/Auckland', sweep('2026-09-26T08:00:00Z', 40, 45)],
];

describe('T-559 R1 parity: the tablet copy answers exactly what the domain answers', () => {
  for (const [zone, instants] of ZONES) {
    for (const [name, w] of Object.entries(WINDOWS)) {
      it(`${zone} / ${name}: contains, next boundary and next opening agree on ${instants.length} instants`, () => {
        for (const at of instants) {
          expect(contains(w, at, zone), `contains ${at.toISOString()}`).toBe(daypartContains(w, at, zone));
          expect(nextBoundary([w], at, zone)?.getTime() ?? null, `nextBoundary ${at.toISOString()}`).toBe(nextDaypartBoundary([w], at, zone)?.getTime() ?? null);
          const live = resolveLiveOffer([{ id: 'o', effectiveFrom: new Date(0), withdrawn: false, daypartId: w.id }], [w], at, zone);
          if (live.kind === 'not_offered_now') {
            const open = nextOpening([w], at, zone);
            expect(open?.at.getTime() ?? null).toBe(live.availableAt?.getTime() ?? null);
            expect(open?.time ?? null).toBe(live.availableFrom);
          }
        }
      });
    }
  }
  it('several windows at once: the earliest boundary of the set', () => {
    const set = [WINDOWS.lunch!, WINDOWS.dinner!, WINDOWS.weekdayMorning!, WINDOWS.sundayLate!];
    for (const at of [...MANILA_INSTANTS, ...WEEK.slice(0, 60)]) {
      expect(nextBoundary(set, at, 'Asia/Manila')?.getTime() ?? null).toBe(nextDaypartBoundary(set, at, 'Asia/Manila')?.getTime() ?? null);
    }
  });
  it.each(['', '  ', 'Asia/Manilla', 'Nowhere/None'])('an unusable zone (%j) holds nothing and has no boundary, as in the domain', (zone) => {
    const at = manila('2026-11-01', '12:00');
    expect(contains(WINDOWS.lunch!, at, zone)).toBe(false);
    expect(daypartContains(WINDOWS.lunch!, at, zone)).toBe(false);
    expect(nextBoundary([WINDOWS.lunch!], at, zone)).toBeNull();
  });
  it('an unusable instant holds nothing and has no boundary', () => {
    expect(contains(WINDOWS.lunch!, new Date(NaN), 'Asia/Manila')).toBe(false);
    expect(nextBoundary([WINDOWS.lunch!], new Date(NaN), 'Asia/Manila')).toBeNull();
  });
  it('the copy imports nothing from @shareat (a client file may not reach the domain barrel)', () => {
    const src = readFileSync(new URL('../src/lib/pos-device/daypart-client.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s*['"]@shareat\//);
  });
});

describe('T-559 R1: the rules themselves, so a bug shared by both sides cannot hide behind parity', () => {
  const L = WINDOWS.lunch!, D = WINDOWS.dinner!, Z = 'Asia/Manila';
  const hold = (w: DaypartWindow, hhmm: string, date = '2026-11-01') => contains(w, manila(date, hhmm), Z);
  it('both sides of 17:00 and 08:00: start inclusive, end exclusive', () => {
    expect([hold(L, '07:59'), hold(L, '08:00'), hold(L, '16:59'), hold(L, '17:00')]).toEqual([false, true, true, false]);
    expect([hold(D, '16:59'), hold(D, '17:00'), hold(D, '07:59'), hold(D, '08:00')]).toEqual([false, true, true, false]);
  });
  it('midnight: dinner (17:00-08:00) holds 00:00, lunch does not', () => {
    expect([hold(D, '00:00'), hold(L, '00:00')]).toEqual([true, false]);
  });
  it('a weekend day missing from `days` holds nothing', () => {
    expect(hold(WINDOWS.weekdayMorning!, '10:00', '2026-11-01')).toBe(false);
    expect(hold(WINDOWS.weekdayMorning!, '10:00', '2026-11-02')).toBe(true);
  });
  it('boundaries are strictly after now; the next opening is never a closing', () => {
    expect(nextBoundary([L, D], manila('2026-11-01', '16:59'), Z)).toEqual(manila('2026-11-01', '17:00'));
    expect(nextBoundary([L, D], manila('2026-11-01', '17:00'), Z)).toEqual(manila('2026-11-02', '08:00'));
    expect(nextOpening([L], manila('2026-11-01', '17:00'), Z)).toEqual({ at: manila('2026-11-02', '08:00'), time: '08:00' });
    expect(nextOpening([], manila('2026-11-01', '12:00'), Z)).toBeNull();
  });
});

describe('T-559 R1: resolveSlot(variant, hours, at)', () => {
  const lunchRow = { orderable: true as const, amount: '449.00', bundleHeads: null, extraHeadAmount: null };
  const dinnerRow = { orderable: true as const, amount: '549.00', bundleHeads: null, extraHeadAmount: null };
  const none = { orderable: false as const, notOffered: 'no_offer' };
  const hours = { timeZone: 'Asia/Manila', dayparts: [{ id: 'lunch', days: ALL, start: '08:00', end: '17:00' }, { id: 'dinner', days: ALL, start: '17:00', end: '08:00' }] };
  const dayparted = { channels: { store: lunchRow }, slots: [{ daypartId: 'lunch', store: lunchRow }, { daypartId: 'dinner', store: dinnerRow }] };

  it('returns the slot whose window holds `at`: lunch price at 16:59, dinner price at 17:01', () => {
    expect(resolveSlot(dayparted, hours, manila('2026-11-01', '16:59'))).toEqual({ orderable: true, offer: lunchRow });
    expect(resolveSlot(dayparted, hours, manila('2026-11-01', '17:01'))).toEqual({ orderable: true, offer: dinnerRow });
  });
  it('FAIL CLOSED on zero slots holding: not orderable, reason no_price_for_this_time, and when it opens', () => {
    const lunchOnly = { channels: { store: lunchRow }, slots: [{ daypartId: 'lunch', store: lunchRow }] };
    expect(resolveSlot(lunchOnly, hours, manila('2026-11-01', '17:01'))).toEqual({ orderable: false, reason: 'no_price_for_this_time', availableFrom: '08:00' });
  });
  it('FAIL CLOSED on two slots holding (overlapping windows): not orderable, never either price', () => {
    const overlapping = { timeZone: 'Asia/Manila', dayparts: [{ id: 'lunch', days: ALL, start: '08:00', end: '18:00' }, { id: 'dinner', days: ALL, start: '17:00', end: '08:00' }] };
    expect(resolveSlot(dayparted, overlapping, manila('2026-11-01', '17:30'))).toMatchObject({ orderable: false, reason: 'no_price_for_this_time' });
    expect(resolveSlot(dayparted, overlapping, manila('2026-11-01', '12:00'))).toEqual({ orderable: true, offer: lunchRow });
  });
  it('FAIL CLOSED on an unknown window, missing hours, a bad zone or a bad instant', () => {
    expect(resolveSlot(dayparted, { timeZone: 'Asia/Manila', dayparts: [] }, manila('2026-11-01', '12:00'))).toMatchObject({ orderable: false, reason: 'no_price_for_this_time' });
    expect(resolveSlot(dayparted, undefined, manila('2026-11-01', '12:00'))).toMatchObject({ orderable: false, reason: 'no_price_for_this_time' });
    expect(resolveSlot(dayparted, { ...hours, timeZone: 'Nowhere/None' }, manila('2026-11-01', '12:00'))).toMatchObject({ orderable: false });
    expect(resolveSlot(dayparted, hours, new Date(NaN))).toMatchObject({ orderable: false, reason: 'no_price_for_this_time' });
  });
  it('a variant with no `slots` falls back to its channels.store offer (a menu without dayparts works unchanged), with or without hours', () => {
    const plain = { channels: { store: lunchRow } };
    expect(resolveSlot(plain, undefined, manila('2026-11-01', '17:01'))).toEqual({ orderable: true, offer: lunchRow });
    expect(resolveSlot(plain, hours, manila('2026-11-01', '03:00'))).toEqual({ orderable: true, offer: lunchRow });
    expect(resolveSlot({ channels: { store: { orderable: false, notOffered: 'withdrawn' } } }, undefined, new Date())).toEqual({ orderable: false, reason: 'withdrawn' });
    expect(resolveSlot({ channels: { store: { orderable: false, notOffered: 'outside_hours', availableFrom: '17:00' } } }, undefined, new Date())).toEqual({ orderable: false, reason: 'outside_hours', availableFrom: '17:00' });
  });
  it('slots with no STORE row count as no slots (an online-only daypart says nothing about the till)', () => {
    const onlineOnly = { channels: { store: dinnerRow }, slots: [{ daypartId: 'lunch', store: none }, { daypartId: 'dinner', store: none }] };
    expect(resolveSlot(onlineOnly, hours, manila('2026-11-01', '12:00'))).toEqual({ orderable: true, offer: dinnerRow });
  });
  it('a WITHDRAWN slot is not live, so it never holds `at`: "not offered now" (as the domain), with the next opening of the live slots', () => {
    const v = { channels: { store: lunchRow }, slots: [{ daypartId: 'lunch', store: lunchRow }, { daypartId: 'dinner', store: { orderable: false as const, notOffered: 'withdrawn' } }] };
    expect(resolveSlot(v, hours, manila('2026-11-01', '18:00'))).toEqual({ orderable: false, reason: 'no_price_for_this_time', availableFrom: '08:00' });
    expect(resolveSlot(v, hours, manila('2026-11-01', '12:00'))).toEqual({ orderable: true, offer: lunchRow });
  });
  it('a malformed or unknown window on ANOTHER live slot makes the whole variant unanswerable, even at a time its own window holds', () => {
    const broken = { timeZone: 'Asia/Manila', dayparts: [{ id: 'lunch', days: ALL, start: '08:00', end: '17:00' }, { id: 'dinner', days: ALL, start: '25:00', end: '08:00' }] };
    expect(resolveSlot(dayparted, broken, manila('2026-11-01', '12:00'))).toEqual({ orderable: false, reason: 'no_price_for_this_time' });
    expect(resolveSlot(dayparted, { timeZone: 'Asia/Manila', dayparts: [hours.dayparts[0]!] }, manila('2026-11-01', '12:00'))).toEqual({ orderable: false, reason: 'no_price_for_this_time' });
  });
});

// ---- resolveSlot against the domain's resolveLiveOffer, over one table (audit fix 2) -------------------------------------------------------------------
describe('T-559 R1 parity: resolveSlot answers what resolveLiveOffer answers', () => {
  type Row = { dp: string; withdrawn?: boolean };
  const W = (id: string, days: number[], start: string, end: string): DaypartWindow => ({ id, days, start, end });
  const SETS: Record<string, { windows: DaypartWindow[]; rows: Row[] }> = {
    'lunch + dinner, both live': { windows: [W('lunch', ALL, '08:00', '17:00'), W('dinner', ALL, '17:00', '08:00')], rows: [{ dp: 'lunch' }, { dp: 'dinner' }] },
    'lunch only': { windows: [W('lunch', ALL, '08:00', '17:00')], rows: [{ dp: 'lunch' }] },
    'dinner withdrawn (the holding slot at 17:00-08:00 is withdrawn)': { windows: [W('lunch', ALL, '08:00', '17:00'), W('dinner', ALL, '17:00', '08:00')], rows: [{ dp: 'lunch' }, { dp: 'dinner', withdrawn: true }] },
    'both withdrawn': { windows: [W('lunch', ALL, '08:00', '17:00'), W('dinner', ALL, '17:00', '08:00')], rows: [{ dp: 'lunch', withdrawn: true }, { dp: 'dinner', withdrawn: true }] },
    'malformed window on the OTHER slot': { windows: [W('lunch', ALL, '08:00', '17:00'), W('dinner', ALL, '25:00', '08:00')], rows: [{ dp: 'lunch' }, { dp: 'dinner' }] },
    'end equals start on the other slot': { windows: [W('lunch', ALL, '08:00', '17:00'), W('dinner', ALL, '10:00', '10:00')], rows: [{ dp: 'lunch' }, { dp: 'dinner' }] },
    'a slot naming an unknown window': { windows: [W('lunch', ALL, '08:00', '17:00')], rows: [{ dp: 'lunch' }, { dp: 'ghost' }] },
    'overlapping windows': { windows: [W('lunch', ALL, '08:00', '18:00'), W('dinner', ALL, '17:00', '08:00')], rows: [{ dp: 'lunch' }, { dp: 'dinner' }] },
    'day-limited and overnight windows': { windows: [W('wk', [1, 2, 3, 4, 5], '09:00', '12:00'), W('sl', [0], '22:00', '02:00'), W('ss', [6], '23:30', '00:30')], rows: [{ dp: 'wk' }, { dp: 'sl' }, { dp: 'ss' }] },
    'a withdrawn slot beside a live one': { windows: [W('wk', [1, 2, 3, 4, 5], '09:00', '12:00'), W('sl', [0], '22:00', '02:00')], rows: [{ dp: 'wk', withdrawn: true }, { dp: 'sl' }] },
  };
  const AT: Array<[string, Date[]]> = [
    ['Asia/Manila', [...MANILA_INSTANTS, ...WEEK.slice(0, 80)]],
    ['America/New_York', [...NY_INSTANTS, ...WEEK.slice(0, 40)]],
  ];
  for (const [name, set] of Object.entries(SETS)) {
    for (const [zone, instants] of AT) {
      it(`${name} / ${zone}: same verdict on ${instants.length} instants`, () => {
        const offers = set.rows.map((r) => ({ id: r.dp, effectiveFrom: new Date(0), withdrawn: r.withdrawn === true, daypartId: r.dp }));
        const variant = {
          channels: { store: { orderable: true as const, amount: '1.00', bundleHeads: null, extraHeadAmount: null } },
          slots: set.rows.map((r) => ({
            daypartId: r.dp,
            store: r.withdrawn ? { orderable: false as const, notOffered: 'withdrawn' } : { orderable: true as const, amount: r.dp, bundleHeads: null, extraHeadAmount: null },
          })),
        };
        const hours = { timeZone: zone, dayparts: set.windows };
        for (const at of instants) {
          const domain = resolveLiveOffer(offers, set.windows, at, zone);
          const device = resolveSlot(variant, hours, at);
          const label = at.toISOString();
          if (domain.kind === 'offer') {
            expect(device, label).toMatchObject({ orderable: true, offer: { amount: domain.offer.id } });
          } else {
            expect(device.orderable, `${label}: domain says ${domain.kind}`).toBe(false);
            if (domain.kind === 'not_offered_now' && !device.orderable) expect(device.availableFrom ?? null, `${label}: next opening`).toBe(domain.availableFrom);
          }
        }
      });
    }
  }
});
