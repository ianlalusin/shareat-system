/**
 * T-510 S4b - PARITY: the tablet's copy of the window logic (daypart-client.ts) must answer exactly what the domain's daypart.ts answers.
 * One table of instants x windows x zones goes through both. This test may import the domain file (a test is never bundled); the client
 * file may not. daypart.ts is dependency-free, so a relative import is safe under this project's `@shareat/db` alias.
 */
import { describe, expect, it } from 'vitest';
import { daypartContains, nextDaypartBoundary, resolveLiveOffer, type DaypartWindow } from '../../../../../packages/domain/src/menu/daypart';
import { contains, nextBoundary, nextOpening } from './daypart-client';

const ALL = [0, 1, 2, 3, 4, 5, 6];
const WINDOWS: Record<string, DaypartWindow> = {
  lunch: { id: 'lunch', days: ALL, start: '08:00', end: '17:00' },
  dinner: { id: 'dinner', days: ALL, start: '17:00', end: '08:00' },
  weekdayMorning: { id: 'wk', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  sundayLate: { id: 'sl', days: [0], start: '22:00', end: '02:00' },
  satToSun: { id: 'ss', days: [6], start: '23:30', end: '00:30' },
  nyEarly: { id: 'ny', days: ALL, start: '01:30', end: '03:30' }, // straddles the New York clock changes
  endEqualsStart: { id: 'bad1', days: ALL, start: '10:00', end: '10:00' },
  badTime: { id: 'bad2', days: ALL, start: '25:00', end: '10:00' },
  noDays: { id: 'bad3', days: [], start: '10:00', end: '11:00' },
};
const manila = (date: string, hhmm: string): Date => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};

// Asia/Manila, 2026-11-01 is a Sunday.
const MANILA_INSTANTS = [
  ...['03:00', '07:59', '08:00', '16:59', '17:00', '00:00', '23:59'].map((t) => manila('2026-11-01', t)),
  ...['00:30', '01:59', '02:00', '09:00', '11:59', '12:00', '23:30'].map((t) => manila('2026-11-02', t)),
];
// New York: spring forward 2026-03-08 02:00 -> 03:00; fall back 2026-11-01 02:00 -> 01:00. Every 15 minutes across both nights.
const sweep = (fromIso: string, count: number, stepMin: number): Date[] =>
  Array.from({ length: count }, (_, i) => new Date(Date.parse(fromIso) + i * stepMin * 60_000));
const NY_INSTANTS = [...sweep('2026-03-08T04:00:00Z', 24, 15), ...sweep('2026-11-01T04:30:00Z', 32, 15), ...sweep('2026-03-07T20:00:00Z', 36, 60)];
// A week at an awkward step, in a zone with a half-hour offset and one far ahead, so day rollovers are covered too.
const WEEK = sweep('2026-11-01T00:00:00Z', 170, 61);

const ZONES: Array<[string, Date[]]> = [
  ['Asia/Manila', [...MANILA_INSTANTS, ...WEEK]],
  ['America/New_York', [...NY_INSTANTS, ...WEEK]],
  ['Asia/Kolkata', WEEK],
  ['Pacific/Auckland', sweep('2026-09-26T08:00:00Z', 40, 45)], // DST starts 2026-09-27
];

describe('daypart-client parity with the domain', () => {
  for (const [zone, instants] of ZONES) {
    for (const [name, w] of Object.entries(WINDOWS)) {
      it(`${zone} / ${name}: contains, next boundary and next opening agree on ${instants.length} instants`, () => {
        for (const at of instants) {
          expect(contains(w, at, zone), `contains ${at.toISOString()}`).toBe(daypartContains(w, at, zone));
          expect(nextBoundary([w], at, zone)?.getTime() ?? null, `nextBoundary ${at.toISOString()}`).toBe(nextDaypartBoundary([w], at, zone)?.getTime() ?? null);
          const live = resolveLiveOffer([{ id: 'o', effectiveFrom: new Date(0), withdrawn: false, daypartId: w.id }], [w], at, zone);
          if (live.kind === 'not_offered_now') {
            const open = nextOpening([w], at, zone);
            expect(open?.at.getTime() ?? null, `nextOpening ${at.toISOString()}`).toBe(live.availableAt?.getTime() ?? null);
            expect(open?.time ?? null).toBe(live.availableFrom);
          }
        }
      });
    }
  }

  it('several windows at once: the earliest boundary of the set, as the domain says', () => {
    const set = [WINDOWS.lunch!, WINDOWS.dinner!, WINDOWS.weekdayMorning!, WINDOWS.sundayLate!];
    for (const at of [...MANILA_INSTANTS, ...WEEK.slice(0, 60)]) {
      expect(nextBoundary(set, at, 'Asia/Manila')?.getTime() ?? null).toBe(nextDaypartBoundary(set, at, 'Asia/Manila')?.getTime() ?? null);
    }
  });

  it.each(['', '  ', 'Asia/Manilla', 'Nowhere/None'])('an unusable zone (%j): holds nothing, no boundary - same as the domain', (zone) => {
    const at = manila('2026-11-01', '12:00');
    expect(contains(WINDOWS.lunch!, at, zone)).toBe(false);
    expect(daypartContains(WINDOWS.lunch!, at, zone)).toBe(false);
    expect(nextBoundary([WINDOWS.lunch!], at, zone)).toBeNull();
    expect(nextDaypartBoundary([WINDOWS.lunch!], at, zone)).toBeNull();
  });
  it('an unusable instant: holds nothing, no boundary', () => {
    const bad = new Date(NaN);
    expect(contains(WINDOWS.lunch!, bad, 'Asia/Manila')).toBe(false);
    expect(nextBoundary([WINDOWS.lunch!], bad, 'Asia/Manila')).toBeNull();
  });
});

describe('daypart-client: the rules themselves (Manila, Sunday 2026-11-01), so a shared bug cannot hide behind parity', () => {
  const L = WINDOWS.lunch!, D = WINDOWS.dinner!, Z = 'Asia/Manila';
  const hold = (w: DaypartWindow, hhmm: string, date = '2026-11-01') => contains(w, manila(date, hhmm), Z);
  it('start is inclusive, end is exclusive', () => {
    expect([hold(L, '07:59'), hold(L, '08:00'), hold(L, '16:59'), hold(L, '17:00')]).toEqual([false, true, true, false]);
    expect([hold(D, '16:59'), hold(D, '17:00'), hold(D, '07:59'), hold(D, '08:00')]).toEqual([false, true, true, false]);
  });
  it('an overnight window belongs to the day it starts: 03:00 is dinner, not lunch', () => {
    expect(hold(D, '03:00')).toBe(true);
    expect(hold(L, '03:00')).toBe(false);
    const sun = WINDOWS.sundayLate!;
    expect(hold(sun, '23:00')).toBe(true);
    expect(hold(sun, '01:00', '2026-11-02')).toBe(true); // Monday morning, Sunday's window
    expect(hold(sun, '01:00', '2026-11-01')).toBe(false); // Sunday morning belongs to Saturday's (absent) window
  });
  it('a day-limited window holds only on its days', () => {
    const wk = WINDOWS.weekdayMorning!;
    expect(hold(wk, '10:00', '2026-11-01')).toBe(false); // Sunday
    expect(hold(wk, '10:00', '2026-11-02')).toBe(true); // Monday
  });
  it('boundaries: Sunday 16:59 -> 17:00; 17:00 -> Monday 08:00 (strictly after now); next opening is never a closing', () => {
    expect(nextBoundary([L, D], manila('2026-11-01', '16:59'), Z)).toEqual(manila('2026-11-01', '17:00'));
    expect(nextBoundary([L, D], manila('2026-11-01', '17:00'), Z)).toEqual(manila('2026-11-02', '08:00'));
    expect(nextOpening([L], manila('2026-11-01', '17:00'), Z)).toEqual({ at: manila('2026-11-02', '08:00'), time: '08:00' });
    expect(nextOpening([D], manila('2026-11-01', '12:00'), Z)).toEqual({ at: manila('2026-11-01', '17:00'), time: '17:00' });
    expect(nextOpening([], manila('2026-11-01', '12:00'), Z)).toBeNull();
  });
});
