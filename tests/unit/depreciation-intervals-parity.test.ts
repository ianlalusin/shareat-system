/**
 * The depreciation interval list exists in TWO places, and this is the guard that keeps them
 * from drifting apart.
 *
 *   - `packages/domain/src/fixed-assets/schedule.ts` — `DEPRECIATION_INTERVALS` and the
 *     `MONTH_STEP` map. This is the SEMANTICS: how many months a period covers.
 *   - `packages/db/schema/fixed-assets.ts` — the `interval` column's enum. This is the
 *     DATABASE's own list of legal values.
 *
 * ## Why not one list imported by both
 *
 * The engine is deliberately pure — every rounding and salvage case it handles is provable with
 * no database at all, which is the entire reason it was split out. Importing the schema to share
 * one constant would pull drizzle into it and cost that property to save a duplicated array of
 * four strings. So the list is duplicated ON PURPOSE, and this test is the price of that choice.
 *
 * ⚠️ The failure this catches is quiet. Adding a fifth interval to the engine but not the column
 * yields a value the database rejects at INSERT — loud, and easy. Adding it to the COLUMN but not
 * the engine is the dangerous direction: the row saves happily, and `MONTH_STEP[interval]` is
 * `undefined`, so `Math.ceil(months / undefined)` is `NaN`, `totalPeriods < 1` is false, and the
 * loop runs `NaN` times — producing an empty schedule. The asset then simply never depreciates,
 * looking exactly like an asset that is not due yet. That is DEF-044's signature all over again.
 */
import { describe, expect, it } from 'vitest';
import { DEPRECIATION_INTERVALS, buildSchedule } from '@shareat/domain';
import { schema } from '@shareat/db';
import { money } from '@shareat/core/money';

/** The `interval` column's declared enum values, read off the drizzle column rather than retyped
 *  here — a copy in this file would just be a third list to drift. */
function columnIntervals(): string[] {
  const col = (schema.fixedAssets as unknown as Record<string, { enumValues?: readonly string[] }>)[
    'interval'
  ];
  return [...(col?.enumValues ?? [])];
}

describe('depreciation intervals — engine and column agree', () => {
  it('the column allows exactly what the engine implements', () => {
    expect([...columnIntervals()].sort()).toEqual([...DEPRECIATION_INTERVALS].sort());
  });

  it('semiannual is present in both (bible row 140)', () => {
    expect(DEPRECIATION_INTERVALS).toContain('semiannual');
    expect(columnIntervals()).toContain('semiannual');
  });

  it('⭐ every legal interval actually produces a schedule — none silently yields nothing', () => {
    // This is the assertion that would have caught the dangerous direction described above. An
    // interval the column permits but the engine has no month step for returns [] here, which is
    // indistinguishable in production from "this asset is not due yet".
    for (const interval of columnIntervals()) {
      const periods = buildSchedule({
        acquiredOn: '2026-01-01',
        cost: money('120000'),
        salvageValue: money('0'),
        usefulLifeMonths: 24,
        interval: interval as (typeof DEPRECIATION_INTERVALS)[number],
      });
      expect(periods.length, `interval '${interval}' produced no schedule`).toBeGreaterThan(0);
      // And it charges the whole depreciable amount, whatever the cadence.
      expect(Number(periods[periods.length - 1]!.accumulatedAfter)).toBe(120000);
    }
  });
});
