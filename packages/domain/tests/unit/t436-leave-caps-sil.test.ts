import { describe, expect, it } from 'vitest';
import { silEntitlementDays } from '../../src/leave/sil';

/**
 * T-436 case 13 - the pro-rated Service Incentive Leave entitlement for calendar year 2027.
 *
 * CONTRACT (the builder implements this, nothing here is guessed at by the builder):
 *   `packages/domain/src/leave/sil.ts` exports the pure function
 *   `silEntitlementDays(serviceStart: string, year: number): number`, serviceStart as YYYY-MM-DD.
 * Rule (spec D7): full 5 when the 1-year anniversary (serviceStart + 1 year) is on or before 1 Jan of
 * `year`; in the anniversary year `ceil(5 * M / 12)` with M = calendar months left counting the
 * anniversary month; 0 before that year.
 *
 * RED REASON today: the module does not exist yet.
 */
describe('T-436 case 13 - SIL entitlement for 2027, pro-rated and rounded UP', () => {
  const cases: [string, number][] = [
    ['2025-12-15', 5], // anniversary 2026-12-15 is before 1 Jan 2027: full
    ['2026-01-01', 5], // anniversary 2027-01-01 is ON 1 Jan: full (mutant: strict < comparison)
    ['2026-06-01', 3], // M = 7 -> ceil(35/12) = 3
    ['2026-06-15', 3], // mid-month still counts the anniversary month: M = 7 -> 3
    ['2026-12-01', 1], // M = 1 -> ceil(5/12) = 1 (mutant: round down gives 0)
    ['2027-02-01', 0], // anniversary 2028: nothing in 2027
  ];
  for (const [start, days] of cases) {
    it(`service start ${start} -> ${days} day(s)`, () => {
      expect(silEntitlementDays(start, 2027)).toBe(days);
    });
  }

  it('anniversary month boundaries: January anniversary 2027-01-31 start 2026-01-31 is full, Feb 2026-02-01 is 5*11/12 -> 5', () => {
    // 2026-02-01 start -> anniversary 2027-02-01, M = 11 -> ceil(55/12) = ceil(4.58) = 5
    expect(silEntitlementDays('2026-02-01', 2027)).toBe(5);
    // 2026-03-10 -> M = 10 -> ceil(50/12) = ceil(4.17) = 5 (mutant: Math.round gives 4)
    expect(silEntitlementDays('2026-03-10', 2027)).toBe(5);
    // 2026-08-20 -> M = 5 -> ceil(25/12) = ceil(2.08) = 3 (mutant: Math.round gives 2)
    expect(silEntitlementDays('2026-08-20', 2027)).toBe(3);
  });
});
