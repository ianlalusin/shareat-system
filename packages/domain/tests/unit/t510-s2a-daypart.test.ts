/**
 * T-510 S2a - the pure daypart logic. docs/tasks/510-menu-dayparts.md R1, R3, R4.
 * daypart.ts is new: until it exists every test fails at the import.
 * Times below are Asia/Manila wall clock (UTC+8, no DST) turned into UTC instants by `at`.
 * 2026-11-01 is a Sunday, 11-02 Monday, 11-03 Tuesday, 11-08 the next Sunday.
 */
import { describe, expect, it } from 'vitest';
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
    expect(resolveLiveOffer([row('f', null, '1', '2026-12-01')], dayparts, NOW('20:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: null });
  });

  it('only a lunch offer, asked at dinner time: not offered now, available from 08:00', () => {
    const r = resolveLiveOffer([row('l', 'L', '338')], dayparts, NOW('17:30'), TZ);
    expect(r).toEqual({ kind: 'not_offered_now', availableFrom: '08:00' });
  });

  it('only a dinner offer, asked at lunch time: available from 17:00', () => {
    expect(resolveLiveOffer([row('d', 'D', '358')], dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: '17:00' });
  });

  it('a withdrawn latest offer in a daypart offers nothing there, and the older price does not come back', () => {
    const offers = [row('d1', 'D', '358', '2026-01-01'), row('d2', 'D', '358', '2026-10-01', true), row('l', 'L', '338')];
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: '08:00' });
    const lunch = resolveLiveOffer(offers, dayparts, NOW('12:00'), TZ);
    expect(lunch.kind === 'offer' && lunch.offer.id).toBe('l');
  });

  it('every dayparted offer withdrawn: not offered, nothing to wait for', () => {
    const offers = [row('d', 'D', '358', '2026-10-01', true)];
    expect(resolveLiveOffer(offers, dayparts, NOW('20:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: null });
  });

  it('a withdrawn all-day offer is not offered', () => {
    expect(resolveLiveOffer([row('a', null, '298', '2026-10-01', true)], dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: null });
  });

  it('no offers at all: not offered, no availableFrom', () => {
    expect(resolveLiveOffer([], dayparts, NOW('12:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: null });
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
    expect(resolveLiveOffer(offers, [SUN], at('2026-11-03', '03:00'), TZ)).toEqual({ kind: 'not_offered_now', availableFrom: '17:00' });
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
