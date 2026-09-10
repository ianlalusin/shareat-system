import { describe, expect, it } from 'vitest';
import {
  bySeverityThenStatus,
  lastCompletedPeriod,
  selectablePeriods,
} from '../src/app/findings/lib';

/**
 * T-135's surface. The page itself is server-rendered against a real database, so what is worth
 * unit-testing is the two decisions it makes on its own: WHICH month it asks about, and WHAT ORDER
 * the answers appear in.
 */
describe('the period the findings page asks about', () => {
  it('⭐ is the last COMPLETED month, never the current one', () => {
    // ⚠️ This is the whole point. "Did depreciation run for the month we are still in" fires on
    // the 1st and stays wrong for thirty days — the schedule has missed nothing until the month
    // it was for is over.
    expect(lastCompletedPeriod(new Date('2026-08-30T12:00:00Z'))).toBe('2026-07');
    expect(lastCompletedPeriod(new Date('2026-08-01T00:00:01Z'))).toBe('2026-07');
  });

  it('rolls the year back at January without producing month 0', () => {
    expect(lastCompletedPeriod(new Date('2027-01-15T00:00:00Z'))).toBe('2026-12');
  });

  it('offers twelve months back, newest first, all zero-padded', () => {
    const ps = selectablePeriods(new Date('2026-08-30T12:00:00Z'));
    expect(ps).toHaveLength(12);
    expect(ps[0]).toBe('2026-07');
    expect(ps[11]).toBe('2025-08');
    // A close is done by picking a month; an unpadded "2026-7" would never match a stored period.
    expect(ps.every((p) => /^\d{4}-\d{2}$/.test(p))).toBe(true);
  });

  it('⚠️ the default is always selectable — otherwise the page opens on a month it rejects', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    expect(selectablePeriods(now)).toContain(lastCompletedPeriod(now));
  });

  it('⛔ DEF-283: inside the 00:00–08:00 Manila window on the 1st, the period has already rolled', () => {
    // 2026-08-31T19:00:00Z is 2026-09-01 03:00 in Manila — the business month is already
    // September, so the last completed period is August, not July as raw UTC would compute.
    const instant = new Date('2026-08-31T19:00:00Z');
    expect(lastCompletedPeriod(instant)).toBe('2026-08');
    // And the default must still be one of the offered choices, in this window too — the trap
    // T-263 calls out: fixing the default without fixing the list opens the page on a month it
    // rejects.
    expect(selectablePeriods(instant)).toContain(lastCompletedPeriod(instant));
  });
});

describe('the order findings appear in', () => {
  const f = (severity: 'hard' | 'soft', status: 'open' | 'acknowledged') => ({ severity, status });

  it('⭐ hard before soft — a list becomes a queue', () => {
    expect(bySeverityThenStatus(f('hard', 'open'), f('soft', 'open'))).toBeLessThan(0);
    expect(bySeverityThenStatus(f('soft', 'open'), f('hard', 'open'))).toBeGreaterThan(0);
  });

  it('within a severity, open before accepted', () => {
    expect(bySeverityThenStatus(f('hard', 'open'), f('hard', 'acknowledged'))).toBeLessThan(0);
    expect(bySeverityThenStatus(f('soft', 'acknowledged'), f('soft', 'open'))).toBeGreaterThan(0);
  });

  it('⛔ an ACCEPTED HARD finding still outranks an open soft one', () => {
    // Accepting a risk is not the same as the books adding up: a hard finding blocks the close
    // whether or not somebody accepted it, so it must not be pushed below softer noise.
    expect(bySeverityThenStatus(f('hard', 'acknowledged'), f('soft', 'open'))).toBeLessThan(0);
  });

  it('sorts a mixed list into hard-open, hard-accepted, soft-open, soft-accepted', () => {
    const rows = [f('soft', 'acknowledged'), f('hard', 'acknowledged'), f('soft', 'open'), f('hard', 'open')];
    expect([...rows].sort(bySeverityThenStatus)).toEqual([
      f('hard', 'open'),
      f('hard', 'acknowledged'),
      f('soft', 'open'),
      f('soft', 'acknowledged'),
    ]);
  });
});
