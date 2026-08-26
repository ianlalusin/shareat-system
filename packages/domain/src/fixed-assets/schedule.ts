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
import { add, money, subtract, type Money } from '@shareat/core/money';

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
  /** `YYYY-MM-DD`. The first period starts in this month. */
  acquiredOn: string;
  cost: Money;
  salvageValue: Money;
  /** MONTHS (bible row 140), not years. */
  usefulLifeMonths: number;
  interval: DepreciationInterval;
}

export interface SchedulePeriod {
  /** `YYYY-MM` — the period this charge belongs to, and the key its posting is idempotent on. */
  period: string;
  /** The business date the entry posts on: the LAST day of the period's final month, so a charge
   *  always lands inside the period it describes. */
  entryDate: string;
  amount: Money;
  /** Cumulative through this period — what the ledger should show once it has posted. */
  accumulatedAfter: Money;
}

function lastDayOfMonth(year: number, month1: number): string {
  // month1 is 1-based. Day 0 of the NEXT month is the last day of this one, and it handles
  // February and leap years without a table.
  const d = new Date(Date.UTC(year, month1, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Every period this asset will ever charge, in order.
 *
 * Straight line only — and that is not laziness: **changing the depreciation method requires BIR
 * approval** (discovery 25), so offering a second method in a dropdown would let someone create a
 * filing obligation with a click.
 */
export function buildSchedule(input: ScheduleInput): SchedulePeriod[] {
  const monthStep = MONTH_STEP[input.interval];
  if (!Number.isFinite(input.usefulLifeMonths) || input.usefulLifeMonths < 1) return [];

  // ⭐ CEIL, not round. A life need not divide evenly by its interval — 25 months charged
  // quarterly is 8⅓ periods. Rounding down to 8 stops depreciating at month 24 and leaves the
  // asset carrying value it should have consumed; ceiling to 9 gives the last period a short
  // stub, which is what actually happens. Either way the schedule still sums to exactly the
  // depreciable amount (the remainder lands on the last period below), so the choice only moves
  // WHEN it finishes — and finishing early is the one of the two that understates nothing.
  const totalPeriods = Math.ceil(input.usefulLifeMonths / monthStep);
  if (totalPeriods < 1) return [];

  const depreciable = subtract(input.cost, input.salvageValue);
  if (Number(depreciable) <= 0) return [];

  // Work in centavos so the division is exact and the remainder is visible rather than rounded
  // away. Money is already 2dp; this just makes the arithmetic integer.
  const totalCentavos = Math.round(Number(depreciable) * 100);
  const per = Math.floor(totalCentavos / totalPeriods);
  const remainder = totalCentavos - per * totalPeriods;

  const [y, m] = input.acquiredOn.split('-').map(Number) as [number, number, number];
  const periods: SchedulePeriod[] = [];
  let accumulated = money('0');

  for (let i = 0; i < totalPeriods; i++) {
    // ⭐ The remainder lands entirely on the LAST period. Every earlier charge is identical, which
    // is what a reader expects of "straight line", and the schedule still sums to exactly the
    // depreciable amount.
    const centavos = i === totalPeriods - 1 ? per + remainder : per;
    const amount = money((centavos / 100).toFixed(2));
    accumulated = add(accumulated, amount);

    const monthsIn = i * monthStep;
    const endMonthIndex = m - 1 + monthsIn + (monthStep - 1);
    const year = y + Math.floor(endMonthIndex / 12);
    const month1 = (endMonthIndex % 12) + 1;

    periods.push({
      period: `${year}-${String(month1).padStart(2, '0')}`,
      entryDate: lastDayOfMonth(year, month1),
      amount,
      accumulatedAfter: accumulated,
    });
  }

  return periods;
}

/**
 * The single period due for `asOfPeriod` (`YYYY-MM`), or `null` if this asset owes nothing then —
 * because it had not been acquired yet, or is already fully depreciated, or its interval simply
 * does not charge in that month.
 *
 * ⚠️ **Returning null rather than zero is deliberate.** A zero charge would post an entry that
 * says nothing happened, and *"an asset with no depreciation posted for a closed period"* is the
 * OIL finding that catches DEF-044 — a stream of zero entries would hide exactly the signal that
 * finding depends on.
 */
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
