/**
 * Straight-line spreading — the arithmetic shared by depreciation (T-124) and amortisation
 * (T-125). One amount, N periods, no money lost.
 *
 * ## ⭐ Why this is shared rather than written twice
 *
 * v1 hand-copied its two runners — the idempotency probe, the transaction shape, the account
 * seeding — and **the copies then drifted**: assets gained a per-month void, prepaid never did.
 * The duplication is what ALLOWED the drift. So the arithmetic lives once, and the two callers
 * differ only where they genuinely differ (T-125 §10).
 *
 * ## The two things this must never do
 *
 *   1. **Lose money to rounding.** An amount divided into N periods will not divide evenly in
 *      pesos. The remainder lands entirely on the LAST period, so the schedule sums to exactly
 *      the amount given. ⚠️ Spreading it evenly and hoping is how a register ends a few centavos
 *      off forever, which is the kind of error nobody ever finds time to chase.
 *   2. **Overshoot.** Every earlier charge is identical — which is what a reader expects of
 *      "straight line" — and the total is fixed, so the final balance is exact rather than
 *      approximately right.
 */
import { add, compare, money, toCentavos, ZERO, type Money } from '@shareat/core/money';

export interface StraightLineInput {
  /** `YYYY-MM-DD`. The first period starts in this month. */
  startsOn: string;
  /** The total to spread. ⚠️ Already NET of anything not being spread — T-124 passes
   *  `cost − salvage`, T-125 passes the whole prepayment because a prepaid runs to zero. */
  amount: Money;
  /** How many charges. The caller decides this, because the two tasks count differently: an
   *  asset's life divided by its interval, a prepaid's coverage in months. */
  periods: number;
  /** How many months each charge covers. `1` for monthly and for every prepaid. */
  monthStep: number;
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

/** Every period this schedule will ever charge, in order. Empty when there is nothing to spread. */
export function buildStraightLine(input: StraightLineInput): SchedulePeriod[] {
  if (!Number.isFinite(input.periods) || input.periods < 1) return [];
  // T-371: `amount` is a branded `Money`, so the positivity test is `compare` on the brand, not a float `Number()` compare.
  if (compare(input.amount, ZERO) <= 0) return [];

  // Work in centavos so the division is exact and the remainder is visible rather than rounded
  // away. Money is already 2dp; this just makes the arithmetic integer.
  const totalCentavos = Number(toCentavos(input.amount));
  const per = Math.floor(totalCentavos / input.periods);
  const remainder = totalCentavos - per * input.periods;

  const [y, m] = input.startsOn.split('-').map(Number) as [number, number, number];
  const periods: SchedulePeriod[] = [];
  let accumulated = money('0');

  for (let i = 0; i < input.periods; i++) {
    // ⭐ The remainder lands entirely on the LAST period.
    const centavos = i === input.periods - 1 ? per + remainder : per;
    const amount = money((centavos / 100).toFixed(2));
    accumulated = add(accumulated, amount);

    const monthsIn = i * input.monthStep;
    const endMonthIndex = m - 1 + monthsIn + (input.monthStep - 1);
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
 * Every period from the start through `asOfPeriod` inclusive — the catch-up list.
 *
 * ⭐ **This is the DEF-044 answer**, and it is why both callers share it: with an idempotent
 * posting per period, catching up is not a repair script, it is **running the same thing again**
 * and letting the ones already posted no-op.
 */
export function periodsThroughOf(
  schedule: SchedulePeriod[],
  asOfPeriod: string,
): SchedulePeriod[] {
  return schedule.filter((p) => p.period <= asOfPeriod);
}
