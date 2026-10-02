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
 * | `fixed_days` | the next occurrence of this period's day, on or after the end — except day 30 for a period ending on the 31st, which pays on the 30th (Ian, 2026-10-01, A3) |
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

  // T-370 S3b (DEF-553, R10; Ian, 2026-10-01): the ONE case a payday falls before its period ends. A day-30
  // payday for a period ending on the 31st is the 30th of the period's OWN month (the 31st is paid with it) -
  // "on or after the end" would roll it to NEXT month's 30th, 31 days on. The start guard keeps a pure caller's
  // 31-31 period (a cutoff clamped to `last - 1`) on the old roll, since day 30 is before it starts.
  const ownMonth = period.end.slice(0, 8);
  if (wanted === 30 && period.end.slice(8) === '31' && period.start <= `${ownMonth}30`) return `${ownMonth}30`;

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

/** Whole days between two `YYYY-MM-DD` dates. UTC midnights, so no DST drift. Local: this file imports nothing. */
function wholeDaysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The canonical calendar `maxPayoutGapDays` measures (T-370 A4, R11): paydays are generated for these months,
 *  and a gap counts when its EARLIER payday lies inside the pair frame. Both are private, named once. */
const GAP_HORIZON_FROM = { year: 2027, month: 11 } as const;
const GAP_HORIZON_TO = { year: 2032, month: 3 } as const;
const GAP_PAIR_FROM = '2028-01-01';
const GAP_PAIR_TO = '2031-12-31';

/**
 * ⭐ T-370 S3 (DEF-409, R8) as amended by A4/R11. The largest gap, in whole days, between consecutive DISTINCT payout
 * dates of a cadence - a property of the CONFIGURATION, never of a start date: it takes none. The ONE gap function:
 * `supersedeConfig` calls it to refuse a cycle on save, and the T-332 detector (`payoutIntervalFindings`) calls it to
 * report one, so what the first accepts the second can never flag (invariant 6).
 *
 * How: every period's payday for months 2027-11 through 2032-03 (`periodIndex` resets per month, as the detector
 * always called it), distinct and sorted; the answer is the largest gap between consecutive paydays `(a, b)` whose
 * EARLIER date `a` lies in 2028-01-01..2031-12-31 (`b` may fall in 2032).
 *
 * Why four years: a payday depends on the calendar only through month lengths, and from 2001 to 2099 the month-length
 * sequence repeats every 48 months (1,461 days), so the payday sequence repeats with it - one repeat's worth of left
 * endpoints sees every gap exactly once, and 2028-2031 holds every run of months a Gregorian year can produce
 * (leap February included; 2100 too). Why the horizon is complete: a payday never falls before its own month starts
 * (fixed and lag paydays are on or after the period end; R10's is the end minus one, the 30th), so every payday before
 * 2032-04-01 is generated, and the successor of any `a` <= 2031-12-31 is <= 2032-03-02.
 *
 * ⛔ **Anchor on the EARLIER date; do not "simplify" to a start month, a 12-month window, or both ends in 2028-2031.**
 * A start-dependent window loses the month before it (cutoff 10 + `[10,25]`, truth 16, measured 31 from three starts) and
 * can lose a leap February (cutoff 15 + `[13,29]`, truth 31, measured 16). Requiring both ends inside the frame drops the
 * 2031-12 -> 2032-01 pair and agrees with this only by a coincidence of month lengths.
 */
export function maxPayoutGapDays(periodCfg: PeriodConfig, payoutCfg: PayoutConfig): number {
  const dates = new Set<string>();
  let y: number = GAP_HORIZON_FROM.year;
  let m: number = GAP_HORIZON_FROM.month;
  while (y < GAP_HORIZON_TO.year || (y === GAP_HORIZON_TO.year && m <= GAP_HORIZON_TO.month)) {
    derivePeriods(periodCfg, y, m).forEach((period, periodIndex) => {
      dates.add(payoutDateFor(period, payoutCfg, periodIndex));
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const sorted = [...dates].sort();
  let max = 0;
  for (let i = 1; i < sorted.length; i++) {
    const earlier = sorted[i - 1]!;
    if (earlier > GAP_PAIR_TO) break;
    if (earlier < GAP_PAIR_FROM) continue;
    max = Math.max(max, wholeDaysBetween(earlier, sorted[i]!));
  }
  return max;
}
