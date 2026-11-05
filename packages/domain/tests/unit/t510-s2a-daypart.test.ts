/**
 * T-510 S2a - the pure daypart logic. docs/tasks/510-menu-dayparts.md R1, R3, R4.
 * daypart.ts is new: until it exists every test fails at the import.
 * Times below are Asia/Manila wall clock (UTC+8, no DST) turned into UTC instants by `at`.
 * 2026-11-01 is a Sunday, 11-02 Monday, 11-03 Tuesday, 11-08 the next Sunday.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  daypartContains,
  daypartsOverlap,
  nextDaypartBoundary,
  resolveLiveOffer,
  validateDaypart,
  type DaypartWindow,
} from '../../src/menu/daypart';

const TZ = 'Asia/Manila';
const ALL = [0, 1, 2, 3, 4, 5, 6];

/** Manila wall clock -> the UTC instant (Manila is a fixed +08:00). */
const at = (date: string, hhmm: string): Date => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0));
};

const NOTHING = { kind: 'not_offered_now', availableFrom: null, availableAt: null, availableDay: null };

const LUNCH: DaypartWindow = { id: 'L', days: ALL, start: '08:00', end: '17:00' };
const DINNER: DaypartWindow = { id: 'D', days: ALL, start: '17:00', end: '08:00' };

describe('validateDaypart', () => {
  const ok = (w: Partial<DaypartWindow>) => validateDaypart({ id: 'x', days: [1], start: '08:00', end: '17:00', ...w });
  it('accepts a same-day and an overnight window', () => {
    expect(ok({})).toEqual({ ok: true });
    expect(ok({ start: '17:00', end: '08:00' })).toEqual({ ok: true });
  });
  it('refuses end === start', () => {
    expect(ok({ start: '08:00', end: '08:00' })).toEqual({ ok: false, reason: 'end_equals_start' });
  });
  it('refuses empty, duplicate and out-of-range days', () => {
    expect(ok({ days: [] })).toEqual({ ok: false, reason: 'days_empty' });
    expect(ok({ days: [1, 1] })).toEqual({ ok: false, reason: 'days_duplicate' });
    expect(ok({ days: [7] })).toEqual({ ok: false, reason: 'days_out_of_range' });
    expect(ok({ days: [-1] })).toEqual({ ok: false, reason: 'days_out_of_range' });
    expect(ok({ days: [1.5] })).toEqual({ ok: false, reason: 'days_out_of_range' });
  });
  it('refuses malformed times', () => {
    expect(ok({ start: '8:00' })).toEqual({ ok: false, reason: 'start_invalid' });
    expect(ok({ start: '24:00' })).toEqual({ ok: false, reason: 'start_invalid' });
    expect(ok({ end: '12:60' })).toEqual({ ok: false, reason: 'end_invalid' });
    expect(ok({ end: 'noon' })).toEqual({ ok: false, reason: 'end_invalid' });
  });
});

describe('daypartContains - Lipa Lunch 08:00-17:00 and Dinner 17:00-08:00, every day', () => {
  // [Manila time, in lunch, in dinner]
  const table: Array<[string, boolean, boolean]> = [
    ['07:59', false, true],
    ['08:00', true, false],
    ['16:59', true, false],
    ['17:00', false, true],
    ['23:59', false, true],
    ['00:00', false, true],
    ['03:00', false, true],
  ];
  for (const [t, inLunch, inDinner] of table) {
    it(`Monday ${t}`, () => {
      expect(daypartContains(LUNCH, at('2026-11-02', t), TZ)).toBe(inLunch);
      expect(daypartContains(DINNER, at('2026-11-02', t), TZ)).toBe(inDinner);
    });
  }
  it('takes the instant in UTC, not the machine clock: 2026-11-02T09:00:00Z is 17:00 Manila', () => {
    expect(daypartContains(DINNER, new Date('2026-11-02T09:00:00Z'), TZ)).toBe(true);
    expect(daypartContains(LUNCH, new Date('2026-11-02T08:59:00Z'), TZ)).toBe(true);
  });
});

describe('daypartContains - an overnight window belongs to the day it starts', () => {
  const SUN: DaypartWindow = { id: 'S', days: [0], start: '17:00', end: '08:00' };
  it('Sunday 17:00 through Monday 07:59', () => {
    expect(daypartContains(SUN, at('2026-11-01', '17:00'), TZ)).toBe(true);
    expect(daypartContains(SUN, at('2026-11-01', '23:59'), TZ)).toBe(true);
    expect(daypartContains(SUN, at('2026-11-02', '00:00'), TZ)).toBe(true);
    expect(daypartContains(SUN, at('2026-11-02', '07:59'), TZ)).toBe(true);
  });
  it('Monday 03:00 belongs to the Sunday window', () => {
    expect(daypartContains(SUN, at('2026-11-02', '03:00'), TZ)).toBe(true);
  });
  it('Monday 08:00 (end exclusive) and Monday 17:00 are outside', () => {
    expect(daypartContains(SUN, at('2026-11-02', '08:00'), TZ)).toBe(false);
    expect(daypartContains(SUN, at('2026-11-02', '17:00'), TZ)).toBe(false);
  });
  it('Tuesday 03:00 does not (Monday is not a window day)', () => {
    expect(daypartContains(SUN, at('2026-11-03', '03:00'), TZ)).toBe(false);
  });
  it('Sunday 03:00 does not (that tail belongs to Saturday)', () => {
    expect(daypartContains(SUN, at('2026-11-01', '03:00'), TZ)).toBe(false);
  });
  it('Saturday-night window spills into Sunday morning', () => {
    const SAT: DaypartWindow = { id: 'T', days: [6], start: '22:00', end: '02:00' };
    expect(daypartContains(SAT, at('2026-11-01', '01:30'), TZ)).toBe(true);
    expect(daypartContains(SAT, at('2026-11-01', '02:00'), TZ)).toBe(false);
  });
});

describe('daypartContains - start inclusive, end exclusive, same-day', () => {
  const W: DaypartWindow = { id: 'W', days: [1], start: '10:00', end: '11:00' };
  it('10:00 in, 10:59 in, 11:00 out, 09:59 out', () => {
    expect(daypartContains(W, at('2026-11-02', '10:00'), TZ)).toBe(true);
    expect(daypartContains(W, at('2026-11-02', '10:59'), TZ)).toBe(true);
    expect(daypartContains(W, at('2026-11-02', '11:00'), TZ)).toBe(false);
    expect(daypartContains(W, at('2026-11-02', '09:59'), TZ)).toBe(false);
  });
  it('wrong day of week is out', () => {
    expect(daypartContains(W, at('2026-11-03', '10:30'), TZ)).toBe(false);
  });
  it('an invalid window contains nothing (fails closed)', () => {
    expect(daypartContains({ id: 'bad', days: [1], start: '10:00', end: '10:00' }, at('2026-11-02', '10:00'), TZ)).toBe(false);
  });
});

describe('daypartContains - a timezone with DST does not crash', () => {
  it('America/New_York across the 2026-03-08 spring-forward', () => {
    const w: DaypartWindow = { id: 'n', days: ALL, start: '02:30', end: '03:30' };
    expect(() => daypartContains(w, new Date('2026-03-08T07:30:00Z'), 'America/New_York')).not.toThrow();
    expect(daypartContains({ id: 'n2', days: ALL, start: '09:00', end: '17:00' }, new Date('2026-03-09T14:00:00Z'), 'America/New_York')).toBe(true);
    expect(nextDaypartBoundary([w], new Date('2026-03-08T05:00:00Z'), 'America/New_York')).toBeInstanceOf(Date);
  });
});

describe('daypartsOverlap', () => {
  it('adjacent windows do not overlap (Lunch and Dinner)', () => {
    expect(daypartsOverlap(LUNCH, DINNER)).toBe(false);
    expect(daypartsOverlap(DINNER, LUNCH)).toBe(false);
  });
  it('overlapping same-day windows overlap', () => {
    expect(daypartsOverlap({ id: 'a', days: [1], start: '08:00', end: '12:00' }, { id: 'b', days: [1], start: '11:00', end: '14:00' })).toBe(true);
  });
  it('an overnight window overlaps a same-day window inside its tail', () => {
    const night: DaypartWindow = { id: 'n', days: [1], start: '22:00', end: '06:00' };
    expect(daypartsOverlap(night, { id: 'm', days: [1], start: '20:00', end: '23:00' })).toBe(true);
    expect(daypartsOverlap(night, { id: 'e', days: [2], start: '05:00', end: '07:00' })).toBe(true);
  });
  it('different days do not overlap', () => {
    expect(daypartsOverlap({ id: 'a', days: [1], start: '08:00', end: '17:00' }, { id: 'b', days: [2], start: '08:00', end: '17:00' })).toBe(false);
  });
  it('an overnight spill into the next day overlaps that day window, and not a window that starts after it ends', () => {
    const sunNight: DaypartWindow = { id: 's', days: [0], start: '17:00', end: '08:00' };
    expect(daypartsOverlap(sunNight, { id: 'mon', days: [1], start: '07:00', end: '12:00' })).toBe(true);
    expect(daypartsOverlap(sunNight, { id: 'mon2', days: [1], start: '08:00', end: '12:00' })).toBe(false);
  });
  it('wraps the week: Saturday-night overnight overlaps a Sunday-morning window', () => {
    expect(daypartsOverlap({ id: 'sat', days: [6], start: '22:00', end: '03:00' }, { id: 'sun', days: [0], start: '01:00', end: '02:00' })).toBe(true);
  });
  it('two overnight windows on the same days overlap', () => {
    expect(daypartsOverlap(DINNER, { id: 'late', days: ALL, start: '23:00', end: '05:00' })).toBe(true);
  });
  it('identical windows overlap', () => {
    expect(daypartsOverlap(LUNCH, { ...LUNCH, id: 'copy' })).toBe(true);
  });
});

describe('resolveLiveOffer', () => {
  const dayparts = [LUNCH, DINNER];
  type Row = { id: string; effectiveFrom: Date; withdrawn: boolean; daypartId: string | null; amount: string };
  const row = (id: string, daypartId: string | null, amount: string, from = '2026-01-01', withdrawn = false): Row => ({
    id, daypartId, amount, withdrawn, effectiveFrom: at(from, '00:00'),
  });
  const NOW = (t: string) => at('2026-11-02', t);

  it('Pork and Chicken: one all-day offer is live at every hour and is passed through unchanged', () => {
    const only = row('pc', null, '298');
    for (const t of ['00:00', '07:59', '08:00', '16:59', '17:00', '23:59']) {
      const r = resolveLiveOffer([only], dayparts, NOW(t), TZ);
      expect(r.kind).toBe('offer');
      if (r.kind === 'offer') expect(r.offer).toBe(only);
    }
  });

  it('Pork and Beef: lunch 338 and dinner 358 resolve by the window the clock is in', () => {
    const offers = [row('l', 'L', '338'), row('d', 'D', '358')];
    const pick = (t: string) => {
      const r = resolveLiveOffer(offers, dayparts, NOW(t), TZ);
      return r.kind === 'offer' ? r.offer.amount : r.kind;
    };
    expect(pick('07:59')).toBe('358');
    expect(pick('08:00')).toBe('338');
    expect(pick('16:59')).toBe('338');
    expect(pick('17:00')).toBe('358');
    expect(pick('03:00')).toBe('358');
  });

  it('within one daypart the latest effectiveFrom at or before now wins', () => {
    const offers = [row('d1', 'D', '358', '2026-01-01'), row('d2', 'D', '378', '2026-10-01'), row('l', 'L', '338')];
    const r = resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ);
    expect(r.kind === 'offer' && r.offer.id).toBe('d2');
  });

  it('a future effectiveFrom is ignored', () => {
    const offers = [row('d1', 'D', '358', '2026-01-01'), row('d2', 'D', '400', '2026-12-01')];
    const r = resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ);
    expect(r.kind === 'offer' && r.offer.id).toBe('d1');
    expect(resolveLiveOffer([row('f', null, '1', '2026-12-01')], dayparts, NOW('20:00'), TZ)).toEqual(NOTHING);
  });

  it('only a lunch offer, asked at dinner time: not offered now, available from 08:00', () => {
    const r = resolveLiveOffer([row('l', 'L', '338')], dayparts, NOW('17:30'), TZ);
    expect(r).toEqual({ kind: 'not_offered_now', availableFrom: '08:00', availableAt: at('2026-11-03', '08:00'), availableDay: 2 });
  });

  it('only a dinner offer, asked at lunch time: available from 17:00', () => {
    expect(resolveLiveOffer([row('d', 'D', '358')], dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: '17:00', availableAt: at('2026-11-02', '17:00'), availableDay: 1 });
  });

  it('a withdrawn latest offer in a daypart offers nothing there, and the older price does not come back', () => {
    const offers = [row('d1', 'D', '358', '2026-01-01'), row('d2', 'D', '358', '2026-10-01', true), row('l', 'L', '338')];
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: '08:00', availableAt: at('2026-11-03', '08:00'), availableDay: 2 });
    const lunch = resolveLiveOffer(offers, dayparts, NOW('12:00'), TZ);
    expect(lunch.kind === 'offer' && lunch.offer.id).toBe('l');
  });

  it('every dayparted offer withdrawn: not offered, nothing to wait for', () => {
    const offers = [row('d', 'D', '358', '2026-10-01', true)];
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual(NOTHING);
  });

  it('a withdrawn all-day offer is not offered', () => {
    expect(resolveLiveOffer([row('a', null, '298', '2026-10-01', true)], dayparts, NOW('12:00'), TZ)).toEqual(NOTHING);
  });

  it('no offers at all: not offered, no availableFrom', () => {
    expect(resolveLiveOffer([], dayparts, NOW('12:00'), TZ)).toEqual(NOTHING);
  });

  it('a live all-day offer and a live dayparted offer together is a data error, never a fallback', () => {
    const offers = [row('a', null, '298'), row('d', 'D', '358')];
    const expected = { kind: 'invalid', reason: 'mixed_all_day_and_daypart' };
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual(expected);
    expect(resolveLiveOffer(offers, dayparts, NOW('12:00'), TZ)).toEqual(expected);
  });

  it('a withdrawn dayparted offer next to a live all-day offer is not a mix (the all-day offer applies)', () => {
    const offers = [row('a', null, '298'), row('d', 'D', '358', '2026-10-01', true)];
    const r = resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ);
    expect(r.kind === 'offer' && r.offer.id).toBe('a');
  });

  it('a live offer pointing at a daypart that is not in the list fails closed', () => {
    expect(resolveLiveOffer([row('x', 'GONE', '1')], dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'unknown_daypart' });
  });

  it('two live offers whose windows both hold now fails closed', () => {
    const overlapping = [LUNCH, { id: 'L2', days: ALL, start: '10:00', end: '14:00' }];
    const offers = [row('l', 'L', '338'), row('l2', 'L2', '300')];
    expect(resolveLiveOffer(offers, overlapping, NOW('11:00'), TZ)).toEqual({ kind: 'invalid', reason: 'overlapping_dayparts' });
  });

  it('works at the Sunday-night to Monday-morning seam', () => {
    const SUN: DaypartWindow = { id: 'S', days: [0], start: '17:00', end: '08:00' };
    const offers = [row('s', 'S', '400')];
    const mon3 = resolveLiveOffer(offers, [SUN], at('2026-11-02', '03:00'), TZ);
    expect(mon3.kind === 'offer' && mon3.offer.id).toBe('s');
    expect(resolveLiveOffer(offers, [SUN], at('2026-11-03', '03:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: '17:00', availableAt: at('2026-11-08', '17:00'), availableDay: 0 });
  });
});

describe('nextDaypartBoundary', () => {
  const dayparts = [LUNCH, DINNER];
  it('16:00 -> 17:00 the same day', () => {
    expect(nextDaypartBoundary(dayparts, at('2026-11-02', '16:00'), TZ)).toEqual(at('2026-11-02', '17:00'));
  });
  it('across midnight: 23:00 -> 08:00 the next day', () => {
    expect(nextDaypartBoundary(dayparts, at('2026-11-02', '23:00'), TZ)).toEqual(at('2026-11-03', '08:00'));
  });
  it('after midnight: 03:00 -> 08:00 the same day', () => {
    expect(nextDaypartBoundary(dayparts, at('2026-11-02', '03:00'), TZ)).toEqual(at('2026-11-02', '08:00'));
  });
  it('strictly after now: exactly 17:00 returns the next change, 08:00 tomorrow', () => {
    expect(nextDaypartBoundary(dayparts, at('2026-11-02', '17:00'), TZ)).toEqual(at('2026-11-03', '08:00'));
  });
  it('one second before a boundary returns that boundary', () => {
    expect(nextDaypartBoundary(dayparts, new Date(at('2026-11-02', '08:00').getTime() - 1000), TZ)).toEqual(at('2026-11-02', '08:00'));
  });
  it('a Sunday-only overnight window: on Monday 10:00 the next change is Sunday 17:00', () => {
    const SUN: DaypartWindow = { id: 'S', days: [0], start: '17:00', end: '08:00' };
    expect(nextDaypartBoundary([SUN], at('2026-11-02', '10:00'), TZ)).toEqual(at('2026-11-08', '17:00'));
  });
  it('a Sunday-only overnight window: on Sunday 18:00 the next change is Monday 08:00 (the close)', () => {
    const SUN: DaypartWindow = { id: 'S', days: [0], start: '17:00', end: '08:00' };
    expect(nextDaypartBoundary([SUN], at('2026-11-01', '18:00'), TZ)).toEqual(at('2026-11-02', '08:00'));
  });
  it('no dayparts: null', () => {
    expect(nextDaypartBoundary([], at('2026-11-02', '10:00'), TZ)).toBeNull();
  });
});

// ---- audit fixes (T-510 S2a, independent audit) ------------------------------------------------------------------------

type Row = { id: string; effectiveFrom: Date; withdrawn: boolean; daypartId: string | null; amount: string };
const row = (id: string, daypartId: string | null, amount: string, from = '2026-01-01', withdrawn = false): Row => ({
  id, daypartId, amount, withdrawn, effectiveFrom: at(from, '00:00'),
});
const NOW = (t: string, d = '2026-11-02'): Date => at(d, t);

/** Every ordering of a short array. */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe('nextDaypartBoundary - window ends and the 8-day scan (audit 5a)', () => {
  it('dinner-only: Monday 03:00 -> Monday 08:00 (the close of the window that started Sunday)', () => {
    expect(nextDaypartBoundary([DINNER], at('2026-11-02', '03:00'), TZ)).toEqual(at('2026-11-02', '08:00'));
    expect(nextDaypartBoundary([DINNER], at('2026-11-02', '03:00'), TZ)?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
  it('a Monday-only window already closed, asked Monday 12:00 -> next Monday 08:00 (seven days on)', () => {
    const MON: DaypartWindow = { id: 'M', days: [1], start: '08:00', end: '11:00' };
    expect(nextDaypartBoundary([MON], at('2026-11-02', '12:00'), TZ)).toEqual(at('2026-11-09', '08:00'));
  });
  it('a Monday-only window asked Monday 12:00 while open -> its close at 17:00', () => {
    const MON: DaypartWindow = { id: 'M', days: [1], start: '08:00', end: '17:00' };
    expect(nextDaypartBoundary([MON], at('2026-11-02', '12:00'), TZ)).toEqual(at('2026-11-02', '17:00'));
  });
  it('a sparse-days window (Tue and Fri) asked Friday 12:00 -> next Tuesday', () => {
    const SPARSE: DaypartWindow = { id: 'P', days: [2, 5], start: '10:00', end: '11:00' };
    expect(nextDaypartBoundary([SPARSE], at('2026-11-06', '12:00'), TZ)).toEqual(at('2026-11-10', '10:00'));
  });
  it('an overnight Tuesday-only window asked Wednesday 12:00 -> next Tuesday 17:00 (the open, not the close)', () => {
    const TUE: DaypartWindow = { id: 'T', days: [2], start: '17:00', end: '08:00' };
    expect(nextDaypartBoundary([TUE], at('2026-11-04', '12:00'), TZ)).toEqual(at('2026-11-10', '17:00'));
  });
});

describe('daypartsOverlap - the one-minute edge (audit 5b)', () => {
  const SUN_NIGHT: DaypartWindow = { id: 's', days: [0], start: '17:00', end: '08:00' };
  it('Sunday 17:00-08:00 against Monday 07:59-12:00: overlap by exactly one minute', () => {
    expect(daypartsOverlap(SUN_NIGHT, { id: 'm', days: [1], start: '07:59', end: '12:00' })).toBe(true);
    expect(daypartsOverlap({ id: 'm', days: [1], start: '07:59', end: '12:00' }, SUN_NIGHT)).toBe(true);
  });
  it('against Monday 08:00-12:00: touching, not overlapping', () => {
    expect(daypartsOverlap(SUN_NIGHT, { id: 'm', days: [1], start: '08:00', end: '12:00' })).toBe(false);
  });
});

describe('resolveLiveOffer - not_offered_now says WHEN (audit 1, 5c, 5d)', () => {
  const SUN: DaypartWindow = { id: 'S', days: [0], start: '17:00', end: '08:00' };
  it('a Sunday-only 17:00 window asked Monday 10:00: Sunday, next Sunday 17:00 store-local', () => {
    expect(resolveLiveOffer([row('s', 'S', '400')], [SUN], at('2026-11-02', '10:00'), TZ)).toEqual({
      kind: 'not_offered_now', availableFrom: '17:00', availableAt: at('2026-11-08', '17:00'), availableDay: 0,
    });
  });
  it('availableDay is the store-local weekday, not the UTC one (Sunday 00:30 Manila is Saturday 16:30Z)', () => {
    const W: DaypartWindow = { id: 'W', days: [0], start: '00:30', end: '01:30' };
    const r = resolveLiveOffer([row('w', 'W', '1')], [W], at('2026-11-02', '10:00'), TZ);
    expect(r).toEqual({ kind: 'not_offered_now', availableFrom: '00:30', availableAt: new Date('2026-11-07T16:30:00Z'), availableDay: 0 });
  });
  it('across days: a Tue-Thu window asked Friday 10:00 opens next Tuesday', () => {
    const W: DaypartWindow = { id: 'W', days: [2, 3, 4], start: '09:00', end: '12:00' };
    const r = resolveLiveOffer([row('w', 'W', '1')], [W], at('2026-11-06', '10:00'), TZ);
    expect(r).toEqual({ kind: 'not_offered_now', availableFrom: '09:00', availableAt: at('2026-11-10', '09:00'), availableDay: 2 });
  });
  it('uses LIVE offers only: of three dayparts only the far one has a live offer', () => {
    const A: DaypartWindow = { id: 'A', days: ALL, start: '06:00', end: '09:00' };
    const B: DaypartWindow = { id: 'B', days: ALL, start: '09:00', end: '12:00' };
    const C: DaypartWindow = { id: 'C', days: ALL, start: '20:00', end: '23:00' };
    const offers = [row('a', 'A', '1', '2026-01-01', true), row('c', 'C', '3')]; // B has no offer at all, A is withdrawn
    const r = resolveLiveOffer(offers, [A, B, C], at('2026-11-02', '05:00'), TZ);
    expect(r).toEqual({ kind: 'not_offered_now', availableFrom: '20:00', availableAt: at('2026-11-02', '20:00'), availableDay: 1 });
  });
  it('a window of a daypart the variant does not use never gives the answer, even when it opens first', () => {
    const offers = [row('l', 'L', '338')];
    const r = resolveLiveOffer(offers, [LUNCH, DINNER], at('2026-11-02', '12:00'), TZ);
    expect(r.kind === 'offer' && r.offer.id).toBe('l');
    const r2 = resolveLiveOffer(offers, [LUNCH, DINNER], at('2026-11-02', '17:30'), TZ);
    expect(r2).toEqual({ kind: 'not_offered_now', availableFrom: '08:00', availableAt: at('2026-11-03', '08:00'), availableDay: 2 });
  });
});

describe('resolveLiveOffer - R7: a 06:00 sale is a dinner-price sale (audit 5e)', () => {
  it('Dinner 17:00-08:00 holds 06:00 Manila, the 05:00 business-day cut-off notwithstanding', () => {
    const offers = [row('l', 'L', '338'), row('d', 'D', '358')];
    for (const t of ['05:00', '05:01', '06:00', '07:59']) {
      const r = resolveLiveOffer(offers, [LUNCH, DINNER], at('2026-11-02', t), TZ);
      expect(r.kind === 'offer' && r.offer.amount).toBe('358');
    }
    const eight = resolveLiveOffer(offers, [LUNCH, DINNER], at('2026-11-02', '08:00'), TZ);
    expect(eight.kind === 'offer' && eight.offer.amount).toBe('338');
  });
});

describe('resolveLiveOffer - ties on effectiveFrom fail closed, and order never matters (audit 3, 5f)', () => {
  const dayparts = [LUNCH, DINNER];
  it('two latest offers in one daypart with the same effectiveFrom: tied_offers', () => {
    const offers = [row('d1', 'D', '358', '2026-10-01'), row('d2', 'D', '378', '2026-10-01'), row('l', 'L', '338')];
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual({ kind: 'invalid', reason: 'tied_offers' });
    expect(resolveLiveOffer(offers, dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'tied_offers' });
  });
  it('a tie that differs in withdrawn is also refused (never resolved by array position)', () => {
    const offers = [row('d1', 'D', '358', '2026-10-01', true), row('d2', 'D', '358', '2026-10-01', false)];
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual({ kind: 'invalid', reason: 'tied_offers' });
  });
  it('a tie inside the all-day set is refused', () => {
    const offers = [row('a1', null, '298', '2026-10-01'), row('a2', null, '300', '2026-10-01', true)];
    expect(resolveLiveOffer(offers, dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'tied_offers' });
  });
  it('an older tie under a newer offer does not matter, and a tie in the future does not matter', () => {
    const old = [row('o1', 'D', '1', '2026-01-01'), row('o2', 'D', '2', '2026-01-01'), row('n', 'D', '358', '2026-10-01')];
    const r = resolveLiveOffer(old, dayparts, NOW('20:00'), TZ);
    expect(r.kind === 'offer' && r.offer.id).toBe('n');
    const future = [row('d', 'D', '358'), row('f1', 'D', '1', '2026-12-01'), row('f2', 'D', '2', '2026-12-01')];
    const r2 = resolveLiveOffer(future, dayparts, NOW('20:00'), TZ);
    expect(r2.kind === 'offer' && r2.offer.id).toBe('d');
  });
  const BAD1: DaypartWindow = { id: 'BAD', days: [1], start: '9:00', end: '10:00' };
  const scenarios: Array<[string, Row[], DaypartWindow[], string]> = [
    ['lunch, dinner, older dinner', [row('l', 'L', '338'), row('d2', 'D', '378', '2026-10-01'), row('d1', 'D', '358')], [LUNCH, DINNER], '20:00'],
    ['a tie', [row('d1', 'D', '358', '2026-10-01'), row('d2', 'D', '378', '2026-10-01'), row('l', 'L', '338')], [LUNCH, DINNER], '20:00'],
    ['a withdrawn latest', [row('d1', 'D', '358'), row('d2', 'D', '358', '2026-10-01', true), row('l', 'L', '338')], [LUNCH, DINNER], '20:00'],
    ['one unknown daypart and one invalid window', [row('x', 'GONE', '1'), row('b', 'BAD', '2'), row('l', 'L', '3')], [LUNCH, BAD1], '12:00'],
    ['two invalid windows', [row('b1', 'B1', '1'), row('b2', 'B2', '2')], [{ id: 'B1', days: [], start: '09:00', end: '10:00' }, { id: 'B2', days: [1], start: '09:00', end: '09:00' }], '12:00'],
    ['overlapping windows', [row('a', 'A', '1'), row('b', 'B', '2'), row('c', 'C', '3')], [{ id: 'A', days: ALL, start: '10:00', end: '14:00' }, { id: 'B', days: ALL, start: '11:00', end: '13:00' }, { id: 'C', days: ALL, start: '20:00', end: '22:00' }], '12:00'],
    ['not offered, three live windows', [row('a', 'A', '1'), row('c', 'C', '3'), row('b', 'B', '2')], [{ id: 'A', days: [3], start: '10:00', end: '14:00' }, { id: 'B', days: [5], start: '09:00', end: '10:00' }, { id: 'C', days: [4], start: '20:00', end: '22:00' }], '12:00'],
    ['all-day and dayparted mix', [row('a', null, '1'), row('d', 'D', '2'), row('l', 'L', '3')], [LUNCH, DINNER], '12:00'],
  ];
  for (const [name, offers, dps, t] of scenarios) {
    it(`permuting the input never changes the result: ${name}`, () => {
      const results = permutations(offers).map((o) => JSON.stringify(resolveLiveOffer(o, dps, NOW(t), TZ)));
      expect(new Set(results).size).toBe(1);
      const dpResults = permutations(dps).map((d) => JSON.stringify(resolveLiveOffer(offers, d, NOW(t), TZ)));
      expect(new Set(dpResults).size).toBe(1);
    });
  }
});

describe('bad time zone or instant fails closed with a reason, never throws (audit 2, 5g)', () => {
  const dayparts = [LUNCH, DINNER];
  const allDay = [row('a', null, '298')];
  const badZones: unknown[] = [undefined, null, '', '   ', 'Mars/Olympus', 'Asia/Manilaa', 42];
  for (const z of badZones) {
    it(`time zone ${JSON.stringify(z) ?? 'undefined'}`, () => {
      const tz = z as string;
      expect(resolveLiveOffer(allDay, dayparts, NOW('12:00'), tz)).toEqual({ kind: 'invalid', reason: 'invalid_time_zone' });
      expect(resolveLiveOffer([row('l', 'L', '1')], dayparts, NOW('12:00'), tz)).toEqual({ kind: 'invalid', reason: 'invalid_time_zone' });
      expect(resolveLiveOffer([], dayparts, NOW('12:00'), tz)).toEqual({ kind: 'invalid', reason: 'invalid_time_zone' });
      expect(daypartContains(LUNCH, NOW('12:00'), tz)).toBe(false);
      expect(nextDaypartBoundary(dayparts, NOW('12:00'), tz)).toBeNull();
    });
  }
  it('an invalid Date', () => {
    const bad = new Date(NaN);
    expect(resolveLiveOffer(allDay, dayparts, bad, TZ)).toEqual({ kind: 'invalid', reason: 'invalid_instant' });
    expect(resolveLiveOffer([], dayparts, bad, TZ)).toEqual({ kind: 'invalid', reason: 'invalid_instant' });
    expect(daypartContains(LUNCH, bad, TZ)).toBe(false);
    expect(nextDaypartBoundary(dayparts, bad, TZ)).toBeNull();
  });
  it('does not use the machine time zone: a different machine zone gives the same answer', () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(daypartContains(LUNCH, new Date('2026-11-02T04:00:00Z'), TZ)).toBe(true); // 12:00 Manila
      expect(resolveLiveOffer(allDay, dayparts, NOW('12:00'), undefined as unknown as string)).toEqual({ kind: 'invalid', reason: 'invalid_time_zone' });
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('a live offer whose window is invalid fails closed (audit 2, 5h)', () => {
  const BAD: DaypartWindow = { id: 'BAD', days: [1], start: '8:00', end: '17:00' };
  it('invalid_daypart, not not_offered_now', () => {
    expect(resolveLiveOffer([row('b', 'BAD', '1')], [BAD], NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'invalid_daypart' });
    expect(resolveLiveOffer([row('b', 'BAD', '1')], [{ ...BAD, days: [] }], NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'invalid_daypart' });
    expect(resolveLiveOffer([row('b', 'BAD', '1')], [{ ...BAD, start: '10:00', end: '10:00' }], NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'invalid_daypart' });
  });
  it('invalid even next to a good live window that holds now', () => {
    const offers = [row('l', 'L', '338'), row('b', 'BAD', '1')];
    expect(resolveLiveOffer(offers, [LUNCH, BAD], NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'invalid_daypart' });
  });
  it('a window that is invalid but whose offer is withdrawn (not live) is ignored', () => {
    const offers = [row('l', 'L', '338'), row('b', 'BAD', '1', '2026-01-01', true)];
    const r = resolveLiveOffer(offers, [LUNCH, BAD], NOW('12:00'), TZ);
    expect(r.kind === 'offer' && r.offer.id).toBe('l');
  });
  it("seconds: 'HH:MM:SS' with :00 is accepted (a Postgres time), any other seconds value is not", () => {
    const w = (start: string, end: string) => validateDaypart({ id: 'x', days: [1], start, end });
    expect(w('08:00:00', '17:00:00')).toEqual({ ok: true });
    expect(w('08:00:30', '17:00')).toEqual({ ok: false, reason: 'start_invalid' });
    expect(w('08:00', '17:00:01')).toEqual({ ok: false, reason: 'end_invalid' });
    expect(w('08:00:60', '17:00')).toEqual({ ok: false, reason: 'start_invalid' });
    expect(w('08:00:0', '17:00')).toEqual({ ok: false, reason: 'start_invalid' });
    expect(w('08:00:00', '08:00')).toEqual({ ok: false, reason: 'end_equals_start' });
  });
  it('a window written with :00 seconds behaves exactly like HH:MM, and availableFrom is HH:MM', () => {
    const PG: DaypartWindow = { id: 'PG', days: [1], start: '10:00:00', end: '11:00:00' };
    expect(daypartContains(PG, at('2026-11-02', '10:30'), TZ)).toBe(true);
    expect(daypartContains(PG, at('2026-11-02', '11:00'), TZ)).toBe(false);
    expect(resolveLiveOffer([row('p', 'PG', '1')], [PG], at('2026-11-02', '12:00'), TZ)).toEqual({
      kind: 'not_offered_now', availableFrom: '10:00', availableAt: at('2026-11-09', '10:00'), availableDay: 1,
    });
    expect(nextDaypartBoundary([PG], at('2026-11-02', '10:30'), TZ)).toEqual(at('2026-11-02', '11:00'));
  });
  it('a window with a non-:00 seconds value fails closed in the resolver', () => {
    expect(resolveLiveOffer([row('p', 'P', '1')], [{ id: 'P', days: ALL, start: '10:00:30', end: '11:00' }], NOW('12:00'), TZ)).toEqual({ kind: 'invalid', reason: 'invalid_daypart' });
  });
});

describe('DST: the boundary is the true instant (audit 4, 5i)', () => {
  it('New York 02:30-03:30 on 2026-03-08: the open is 07:00Z (03:00 EDT, the first valid instant after the skipped 02:30)', () => {
    const w: DaypartWindow = { id: 'n', days: ALL, start: '02:30', end: '03:30' };
    expect(nextDaypartBoundary([w], new Date('2026-03-08T05:00:00Z'), 'America/New_York')?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    const r = resolveLiveOffer([row('n', 'n', '1')], [w], new Date('2026-03-08T05:00:00Z'), 'America/New_York');
    expect(r).toEqual({ kind: 'not_offered_now', availableFrom: '02:30', availableAt: new Date('2026-03-08T07:00:00.000Z'), availableDay: 0 });
  });
  it('New York: after the gap, the close at 03:30 EDT is 07:30Z', () => {
    const w: DaypartWindow = { id: 'n', days: ALL, start: '02:30', end: '03:30' };
    expect(nextDaypartBoundary([w], new Date('2026-03-08T07:00:00Z'), 'America/New_York')?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('New York: an ordinary day is unaffected (09:00 EST on 2026-03-07 is 14:00Z)', () => {
    const w: DaypartWindow = { id: 'n', days: ALL, start: '09:00', end: '17:00' };
    expect(nextDaypartBoundary([w], new Date('2026-03-07T10:00:00Z'), 'America/New_York')?.toISOString()).toBe('2026-03-07T14:00:00.000Z');
  });
  it('Lord Howe, clocks back 2026-04-05 02:00 -> 01:30: the 01:45 open is not skipped', () => {
    const w: DaypartWindow = { id: 'h', days: ALL, start: '01:45', end: '02:15' };
    expect(nextDaypartBoundary([w], new Date('2026-04-04T14:00:00Z'), 'Australia/Lord_Howe')?.toISOString()).toBe('2026-04-04T14:45:00.000Z');
    // the second 01:45 (after the clocks went back) is a boundary too; a device must not sleep through it
    expect(nextDaypartBoundary([w], new Date('2026-04-04T14:50:00Z'), 'Australia/Lord_Howe')?.toISOString()).toBe('2026-04-04T15:15:00.000Z');
    expect(nextDaypartBoundary([w], new Date('2026-04-04T15:20:00Z'), 'Australia/Lord_Howe')?.toISOString()).toBe('2026-04-04T15:45:00.000Z');
  });
  it('Lord Howe 30-minute gap in October (2026-10-04 02:00 -> 02:30): a 02:15 open lands on the transition 15:30Z', () => {
    const w: DaypartWindow = { id: 'h', days: ALL, start: '02:15', end: '04:00' };
    expect(nextDaypartBoundary([w], new Date('2026-10-03T15:00:00Z'), 'Australia/Lord_Howe')?.toISOString()).toBe('2026-10-03T15:30:00.000Z');
  });
  it('Asia/Manila is unchanged (no DST): dinner open 17:00 Manila is 09:00Z', () => {
    expect(nextDaypartBoundary([DINNER], new Date('2026-11-02T04:00:00Z'), TZ)?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });
});

describe('an engine that prints midnight as hour 24 (audit 5j)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('is read as hour 0: the next boundary is still the true midnight', () => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, d?: Date | number) {
      return original.call(this, d).map((p) => (p.type === 'hour' && p.value === '00' ? { ...p, value: '24' } : p));
    });
    // sanity: the mock is live, an instant at Manila midnight prints "24"
    const probe = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric' }).formatToParts(at('2026-11-03', '00:00'));
    expect(probe.find((p) => p.type === 'hour')?.value).toBe('24');
    const night: DaypartWindow = { id: 'N', days: ALL, start: '00:00', end: '06:00' };
    expect(nextDaypartBoundary([night], at('2026-11-02', '12:00'), TZ)).toEqual(at('2026-11-03', '00:00'));
    expect(daypartContains(night, at('2026-11-03', '00:00'), TZ)).toBe(true);
    expect(daypartContains(night, at('2026-11-02', '23:59'), TZ)).toBe(false);
  });
});
