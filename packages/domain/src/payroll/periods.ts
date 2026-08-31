/**
 * Which windows a store's pay periods are cut into. T-189c. **Pure — no database, no clock.**
 *
 * Ian, 2026-08-31: *"look how payroll dates are configured in v1, it must be configurable."*
 *
 * ## ⭐ The invariant v1 states and never checks
 *
 * v1's own comment claims *"every mode's periods tile the whole calendar month with no gaps and no
 * overlaps, and periods never cross a month boundary"* — and then relies on it in three other
 * places (`periodForDate`, `payoutCoversDate`, `periodsOverlap`) without a single test asserting
 * it. ⭐ **`tilesTheMonth` below makes it checkable**, and the tests check it for every mode, in
 * every month, across a leap year.
 *
 * ⚠️ **Periods never cross a month boundary**, which is why the weekly mode's last window is short
 * rather than running into the next month. That is v1's behaviour and it is load-bearing: a period
 * that spanned two months would have to be derived from two different configs if the store changed
 * one mid-month.
 */
export interface PayPeriod {
  start: string;
  end: string;
  label: string;
}

export interface PeriodConfig {
  payrollPeriodType: 'monthly' | 'semi_monthly' | 'weekly';
  /** ⚠️ The day the FIRST semi-monthly period ends. The second always runs to month end. */
  semiMonthlyCutoffDay: number;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** ⚠️ `Date.UTC(y, m, 0)` is the last day of month `m` — day 0 of the NEXT month. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The pay periods of one calendar month, in order.
 *
 * ⭐ `month` is 1-indexed, like a human writes a date and unlike `Date`.
 */
export function derivePeriods(config: PeriodConfig, year: number, month: number): PayPeriod[] {
  const last = lastDayOfMonth(year, month);
  const mon = MONTHS[month - 1];

  if (config.payrollPeriodType === 'monthly') {
    return [{ start: dateKey(year, month, 1), end: dateKey(year, month, last), label: `${mon} ${year}` }];
  }

  if (config.payrollPeriodType === 'weekly') {
    const out: PayPeriod[] = [];
    for (let d = 1; d <= last; d += 7) {
      const end = Math.min(d + 6, last);
      out.push({
        start: dateKey(year, month, d),
        end: dateKey(year, month, end),
        // ⚠️ The last window of a month is SHORT, not carried into the next month.
        label: `${mon} ${d}–${end}, ${year}`,
      });
    }
    return out;
  }

  // semi-monthly, the default.
  //
  // ⚠️ The cutoff is clamped here as WELL as by the CHECK constraint, and that is not belt and
  // braces: this function is pure and may be called with a config assembled anywhere, including a
  // test or a future importer. The database stops a bad value being STORED; this stops a bad value
  // producing an inverted period if one ever reaches the function another way.
  const cutoff = Math.min(Math.max(1, config.semiMonthlyCutoffDay), last - 1);
  return [
    { start: dateKey(year, month, 1), end: dateKey(year, month, cutoff), label: `${mon} 1–${cutoff}, ${year}` },
    {
      start: dateKey(year, month, cutoff + 1),
      end: dateKey(year, month, last),
      label: `${mon} ${cutoff + 1}–${last}, ${year}`,
    },
  ];
}

/**
 * ⭐ The invariant, as a function: do these periods cover the month exactly once?
 *
 * True when they start on the 1st, end on the last day, and each one begins the day after the
 * previous ended — no gap, no overlap, nothing outside the month.
 */
export function tilesTheMonth(periods: PayPeriod[], year: number, month: number): boolean {
  if (periods.length === 0) return false;
  const last = lastDayOfMonth(year, month);
  if (periods[0]!.start !== dateKey(year, month, 1)) return false;
  if (periods[periods.length - 1]!.end !== dateKey(year, month, last)) return false;

  for (const p of periods) {
    if (p.end < p.start) return false;
  }
  for (let i = 1; i < periods.length; i++) {
    const prevEnd = Number(periods[i - 1]!.end.slice(8));
    const thisStart = Number(periods[i]!.start.slice(8));
    if (thisStart !== prevEnd + 1) return false;
  }
  return true;
}

/**
 * The period a date falls in, or `null` when it is outside them.
 *
 * ⚠️ String comparison is chronological for `YYYY-MM-DD`, which is why the dates are stored and
 * compared as strings throughout rather than parsed into `Date` and back.
 */
export function periodForDate(config: PeriodConfig, date: string): PayPeriod | null {
  const [y, m] = date.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return derivePeriods(config, y, m).find((p) => date >= p.start && date <= p.end) ?? null;
}

export interface PayoutConfig {
  payoutMode: 'lag' | 'fixed_days';
  payoutLagDays: number;
  /** One day-of-month per period, in period order. ⚠️ Shorter than the period count is legal. */
  payoutDays: number[];
}

/**
 * ⭐ When the money is actually handed over. T-189d — Ian: *"the payout date must be configurable
 * also."*
 *
 * | mode | payday |
 * |---|---|
 * | `lag` | the period end plus N days — v1's only model |
 * | `fixed_days` | the next occurrence of this period's configured day-of-month, on or after the end |
 *
 * ⚠️ **A lag cannot express a fixed payday.** Paid on the 10th and the 25th means a different
 * number of days after each period end, every month — which is why this is a mode and not a
 * cleverer lag.
 *
 * ⚠️ **A day of 31 in a 30-day month CLAMPS to the month end** rather than being refused. "Pay on
 * the last day" is a real instruction and 31 is how people write it.
 */
export function payoutDateFor(
  period: PayPeriod,
  cfg: PayoutConfig,
  periodIndex = 0,
): string {
  if (cfg.payoutMode === 'lag' || cfg.payoutDays.length === 0) {
    const d = new Date(`${period.end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Math.max(0, cfg.payoutLagDays));
    return d.toISOString().slice(0, 10);
  }

  // ⚠️ Fewer entries than periods is legal: the LAST one applies to the rest.
  const wanted = cfg.payoutDays[Math.min(periodIndex, cfg.payoutDays.length - 1)]!;

  const end = new Date(`${period.end}T00:00:00Z`);
  // Try this month, then the next — the payday is either still ahead in the period's own month or
  // it has passed, in which case the money lands next month. Two candidates always suffice.
  for (const monthOffset of [0, 1]) {
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth() + monthOffset;
    const last = lastDayOfMonth(new Date(Date.UTC(y, m, 1)).getUTCFullYear(), new Date(Date.UTC(y, m, 1)).getUTCMonth() + 1);
    const day = Math.min(wanted, last);
    const candidate = new Date(Date.UTC(y, m, day));
    const iso = candidate.toISOString().slice(0, 10);
    if (iso >= period.end) return iso;
  }
  return period.end;
}
