/**
 * The depreciation schedule — a PURE function from an asset's terms to what each period charges.
 * docs/tasks/124-fixed-assets-and-depreciation.md.
 *
 * ## ⭐ Why this is separate from the posting
 *
 * The arithmetic is where depreciation goes quietly wrong — an asset that never quite reaches its
 * salvage value, or that overshoots it by a rounding error in the final period. **Keeping it pure
 * means every one of those cases can be proven without a database**, and the service above is left
 * with nothing to get wrong except which period it is posting.
 *
 * ## The two things this must never do
 *
 *   1. **Depreciate below salvage.** The final period takes the REMAINDER, not another full
 *      instalment — otherwise the last charge overshoots and book value ends below salvage.
 *   2. **Lose money to rounding.** `cost − salvage` divided into N periods will not divide evenly
 *      in pesos. The remainder goes to the LAST period, so the schedule always sums to exactly
 *      the depreciable amount. ⚠️ Spreading it evenly and hoping is how a register ends up a few
 *      centavos off forever, which is the kind of error nobody can ever find time to chase.
 */
import { money, subtract, type Money } from '@shareat/core/money';
import { buildStraightLine, type SchedulePeriod } from '../shared/straight-line';

export type DepreciationInterval = 'monthly' | 'quarterly' | 'semiannual' | 'annually';

/** ⚠️ Kept in step with the `interval` column's enum in packages/db/schema/fixed-assets.ts by
 *  `tests/unit/depreciation-intervals-parity.test.ts`. They live apart so this file stays pure —
 *  importing the schema would pull drizzle into an engine whose whole value is needing no
 *  database to prove. */
export const DEPRECIATION_INTERVALS = ['monthly', 'quarterly', 'semiannual', 'annually'] as const;

/** How many months each period covers. `semiannual` added by bible row 140. */
const MONTH_STEP: Record<DepreciationInterval, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annually: 12,
};

export interface ScheduleInput {
  /** `YYYY-MM-DD`. The first period starts in this month.
   *  ⭐ T-346 S2 (DEF-427) — renamed from `acquiredOn`: the schedule starts when the asset is IN
   *  SERVICE (PAS 16), not necessarily when it was bought. `scheduleInputFor` (`depreciate.ts`)
   *  is what feeds `in_service_on` in here; this file stays ignorant of where the date came from. */
  startsOn: string;
  cost: Money;
  salvageValue: Money;
  /** MONTHS (bible row 140), not years. */
  usefulLifeMonths: number;
  interval: DepreciationInterval;
}

/** Re-exported so existing callers keep importing it from here. The shape lives in
 *  `shared/straight-line.ts` now, because amortisation produces the same thing. */
export type { SchedulePeriod };

/**
 * Every period this asset will ever charge, in order.
 *
 * Straight line only — and that is not laziness: **changing the depreciation method requires BIR
 * approval** (discovery 25), so offering a second method in a dropdown would let someone create a
 * filing obligation with a click.
 *
 * ⭐ The arithmetic itself lives in `shared/straight-line.ts`, shared with amortisation. What is
 * SPECIFIC to depreciation stays here: salvage (a prepaid runs to zero), the interval (a prepaid
 * is always monthly), and the ceil below.
 */
export function buildSchedule(input: ScheduleInput): SchedulePeriod[] {
  const monthStep = MONTH_STEP[input.interval];
  if (!Number.isFinite(input.usefulLifeMonths) || input.usefulLifeMonths < 1) return [];

  // ⭐ CEIL, not round. A life need not divide evenly by its interval — 25 months charged
  // quarterly is 8⅓ periods. Rounding down to 8 stops depreciating at month 24 and leaves the
  // asset carrying value it should have consumed; ceiling to 9 gives the last period a short
  // stub, which is what actually happens. Either way the schedule still sums to exactly the
  // depreciable amount, so the choice only moves WHEN it finishes — and finishing late
  // understates nothing.
  const periods = Math.ceil(input.usefulLifeMonths / monthStep);

  // ⚠️ Salvage is subtracted HERE, not inside the shared module. A prepaid has no salvage — it
  // runs to zero — so the shared arithmetic takes the net amount and knows nothing about it.
  const depreciable = subtract(input.cost, input.salvageValue);

  return buildStraightLine({
    startsOn: input.startsOn,
    amount: depreciable,
    periods,
    monthStep,
  });
}

export function periodDue(input: ScheduleInput, asOfPeriod: string): SchedulePeriod | null {
  return buildSchedule(input).find((p) => p.period === asOfPeriod) ?? null;
}

/**
 * Every period from acquisition through `asOfPeriod` inclusive — the catch-up list.
 *
 * ⭐ **This is the DEF-044 answer.** v1's scheduler stopped for two months and nobody noticed;
 * with an idempotent posting per period, catching up is not a repair script, it is **running the
 * same thing again** and letting the ones already posted no-op.
 */
export function periodsThrough(input: ScheduleInput, asOfPeriod: string): SchedulePeriod[] {
  return buildSchedule(input).filter((p) => p.period <= asOfPeriod);
}

/** What the ledger SHOULD show for this asset once every period through `asOfPeriod` has posted.
 *  ⚠️ Never stored — compared against the ledger, which is the actual figure. */
export function expectedAccumulated(input: ScheduleInput, asOfPeriod: string): Money {
  const through = periodsThrough(input, asOfPeriod);
  return through.length === 0 ? money('0') : through[through.length - 1]!.accumulatedAfter;
}
