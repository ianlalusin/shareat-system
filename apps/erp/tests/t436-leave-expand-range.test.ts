import { describe, expect, it } from 'vitest';
import { expandRange } from '../src/app/attendance/leave/lib';

/**
 * T-436 audit C - `expandRange` used to stop silently at 62 days, so a maternity range (105 days) lost its tail without a word.
 * The domain accepts up to 366 days per request; the form helper must hand it all of them, and a range beyond that must be an
 * ERROR (thrown), never a quietly shortened one.
 */
const none = new Set<string>();

describe('expandRange - no silent truncation', () => {
  it('maternity 1 Mar - 13 Jun 2026 (exactly 105 days) yields all 105, first and last intact', () => {
    const out = expandRange('2026-03-01', '2026-06-13', none);
    expect(out).toHaveLength(105);
    expect(out[0]).toEqual({ date: '2026-03-01', kind: 'leave' });
    expect(out[104]).toEqual({ date: '2026-06-13', kind: 'leave' });
  });

  it('1 Mar - 14 Jun 2026 is 106 calendar days and all 106 come back (not 62)', () => {
    expect(expandRange('2026-03-01', '2026-06-14', none)).toHaveLength(106);
  });

  it('rest days inside a long range are still marked, not dropped', () => {
    const out = expandRange('2026-03-01', '2026-06-13', new Set(['2026-03-08', '2026-06-13']));
    expect(out).toHaveLength(105);
    expect(out.find((d) => d.date === '2026-03-08')?.kind).toBe('rest_day');
    expect(out[104]!.kind).toBe('rest_day');
  });

  it('366 days (the domain ceiling) is allowed', () => {
    expect(expandRange('2026-01-01', '2027-01-01', none)).toHaveLength(366);
  });

  it('367 days is an ERROR, not a 366-day (or 62-day) truncation', () => {
    // MUTANT: the `out.length < N` loop guard stays and just changes N.
    expect(() => expandRange('2026-01-01', '2027-01-02', none)).toThrow();
  });
});
