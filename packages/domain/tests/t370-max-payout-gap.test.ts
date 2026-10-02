import { describe, expect, expectTypeOf, it } from 'vitest';
import * as periods from '../src/payroll/periods';
import type { PayoutConfig, PeriodConfig } from '../src/payroll/periods';

/**
 * T-370 S3 P1 + Amendment A4 (DEF-409) — `maxPayoutGapDays(periodCfg, payoutCfg)`, the ONE gap function `supersedeConfig`
 * (refuse on save) and `payoutIntervalFindings` (the T-332 detector) both call. `docs/tasks/370-owner-cap-dates.md` R8, R11, A4.
 *
 * ⛔ TESTER. Pure unit, no database. R11: the function takes NO date. It judges the cadence, so its answer must not depend on
 * where a caller happens to start counting. The 12-month version of R8 did: cutoff 10 + [10,25] (truth 16) measured 31 from some
 * starts (the month before the window pays INTO it but was never generated), and cutoff 15 + [13,29] (truth 31) measured 16 from a
 * window whose only February is a leap one.
 *
 * ⭐ T0 is the point of this file. The old "reference loop" copied the production loop and shared its defect, so it proved nothing.
 * `truth` below is a DIFFERENT frame, written here and never imported from production: every payday of 2025-11..2046-03 (21 years,
 * five leap Februaries, not phase-aligned to the 2028 leap cycle the production frame uses), and the largest gap over the pairs whose
 * EARLIER date lies in 2026-01-01..2045-12-31. It borrows only the two calendar primitives `derivePeriods` and `payoutDateFor`.
 *
 * Mutants each leg must turn red (A4 table):
 *   m1  generate from 2028-01 with no earlier months          -> G1, the cutoff-10 [10,25] row
 *   m2  restore the 12-month window from a start month        -> G1, A1 (a start parameter comes back)
 *   m4  frame 2029-01..2031-12, which has no leap February    -> G1, the cutoff-15 [13,29] row
 *   A1  keep the start parameters, even defaulted ones        -> A1 (`expectTypeOf`, and `.length`)
 */

const gap = (p: PeriodConfig, o: PayoutConfig): number =>
  (periods.maxPayoutGapDays as unknown as (p: PeriodConfig, o: PayoutConfig) => number)(p, o);

const semi = (cutoff: number): PeriodConfig => ({ payrollPeriodType: 'semi_monthly', semiMonthlyCutoffDay: cutoff });
const monthly: PeriodConfig = { payrollPeriodType: 'monthly', semiMonthlyCutoffDay: 15 };
const weekly: PeriodConfig = { payrollPeriodType: 'weekly', semiMonthlyCutoffDay: 15 };
const fixed = (days: number[]): PayoutConfig => ({ payoutMode: 'fixed_days', payoutLagDays: 0, payoutDays: days });
const lag = (days = 0): PayoutConfig => ({ payoutMode: 'lag', payoutLagDays: days, payoutDays: [] });

// =================================================================================================
// T0 — the independent ground truth
// =================================================================================================

const TRUTH_FIRST = { y: 2025, m: 11 }; // generated: 2025-11 .. 2046-03
const TRUTH_LAST = { y: 2046, m: 3 };
const PAIR_FROM = '2026-01-01'; // an earlier date `a` in 2026-01-01 .. 2045-12-31
const PAIR_TO = '2045-12-31';

/** Whole days between two YYYY-MM-DD dates (UTC midnights, so no DST drift). */
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The largest consecutive gap, over a sorted distinct date list, whose EARLIER date is in [PAIR_FROM, PAIR_TO]. */
function largestGap(sorted: string[]): number {
  let max = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    if (a < PAIR_FROM) continue;
    if (a > PAIR_TO) break;
    max = Math.max(max, daysBetween(a, sorted[i + 1]!));
  }
  return max;
}

/** Every month of the truth frame, in order. */
const TRUTH_MONTHS: { y: number; m: number }[] = (() => {
  const out: { y: number; m: number }[] = [];
  let { y, m } = TRUTH_FIRST;
  while (y < TRUTH_LAST.y || (y === TRUTH_LAST.y && m <= TRUTH_LAST.m)) {
    out.push({ y, m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
})();

/** truth(p, o): straight from `derivePeriods` / `payoutDateFor`, no memoisation. */
function truth(p: PeriodConfig, o: PayoutConfig): number {
  const dates = new Set<string>();
  for (const { y, m } of TRUTH_MONTHS) periods.derivePeriods(p, y, m).forEach((period, idx) => dates.add(periods.payoutDateFor(period, o, idx)));
  return largestGap([...dates].sort());
}

/**
 * The memoised form the sweep uses. VALID because `payoutDateFor` reads only `wanted = payoutDays[min(periodIndex, len - 1)]`:
 * `payoutDateFor(period, fixed([d]), 0)` is the payday for index i of ANY list whose i-th usable entry is d. So an `[a, b]` store's
 * paydays are index 0 with day a and index 1 with day b, and every (cutoff, month, index, day) cell is computed once.
 * Lag mode ignores the index and the days entirely; its cell key uses the lag as the "day".
 */
class Memo {
  private cells = new Map<string, string>();
  constructor(private p: PeriodConfig) {}
  payday(y: number, m: number, idx: number, o: PayoutConfig, day: number): string {
    const key = `${y}-${m}-${idx}-${o.payoutMode}-${day}`;
    let v = this.cells.get(key);
    if (v === undefined) {
      const period = periods.derivePeriods(this.p, y, m)[idx]!;
      v = periods.payoutDateFor(period, o.payoutMode === 'lag' ? lag(day) : fixed([day]), 0);
      this.cells.set(key, v);
    }
    return v;
  }
  /** `days[i]` is the day used for period index i (the last entry covers the rest, as production does). */
  truth(o: PayoutConfig): number {
    const dates = new Set<string>();
    for (const { y, m } of TRUTH_MONTHS) {
      const n = periods.derivePeriods(this.p, y, m).length;
      for (let idx = 0; idx < n; idx++) {
        const day = o.payoutMode === 'lag' ? o.payoutLagDays : o.payoutDays[Math.min(idx, o.payoutDays.length - 1)]!;
        dates.add(this.payday(y, m, idx, o, day));
      }
    }
    return largestGap([...dates].sort());
  }
}

const TABLE: { name: string; p: PeriodConfig; o: PayoutConfig; expected: number; note?: string }[] = [
  { name: 'semi-monthly, cutoff 15, fixed days [10,25]', p: semi(15), o: fixed([10, 25]), expected: 16 },
  { name: 'semi-monthly, cutoff 15, fixed days [10] (the DEF-409 collapse)', p: semi(15), o: fixed([10]), expected: 31 },
  { name: 'semi-monthly, cutoff 15, fixed days [10,20]', p: semi(15), o: fixed([10, 20]), expected: 21 },
  { name: 'semi-monthly, cutoff 15, LAG 0', p: semi(15), o: lag(), expected: 16 },
  { name: 'semi-monthly, cutoff 10, LAG 0 (R7: the spacing rule covers lag mode)', p: semi(10), o: lag(), expected: 21 },
  { name: 'monthly, LAG 0', p: monthly, o: lag(), expected: 31 },
  {
    name: 'semi-monthly, cutoff 15, fixed days [15,30]',
    p: semi(15), o: fixed([15, 30]), expected: 16,
    note: 'Ian ruled 2026-10-01 (A3, DEF-553): 15/30 is SUPPORTED, the second half pays on the 30th even when it ends on the 31st, so the worst gap is 16 and the store is accepted on save',
  },
  // A4: the three rows the 12-month window got wrong or could not tell apart.
  {
    name: 'semi-monthly, cutoff 10, fixed days [10,25] (A4: the left edge — legal, truth 16)',
    p: semi(10), o: fixed([10, 25]), expected: 16,
    note: 'the 12-month window measured 31 from 2026-10, 2027-01 and 2027-03: the month before the window pays its second period INTO it',
  },
  {
    name: 'semi-monthly, cutoff 15, fixed days [13,29] (A4: the leap February — truth 31)',
    p: semi(15), o: fixed([13, 29]), expected: 31,
    note: 'the 12-month window measured 16 from 2027-03, so a violating store was accepted on save and flagged later',
  },
  { name: 'semi-monthly, cutoff 15, fixed days [10,27] (the 17-day cycle)', p: semi(15), o: fixed([10, 27]), expected: 17 },
];

describe('T0 — the oracle is REAL: `truth` (an independent frame, never imported from production) reproduces every literal in the spec table', () => {
  for (const c of TABLE) {
    it(`${c.name} => ${c.expected} by truth`, () => {
      expect(truth(c.p, c.o)).toBe(c.expected);
    });
  }

  it('the memoised form the sweep uses agrees with the plain `truth` on 400 configs across every cadence (it guards the shortcut, not the builder)', () => {
    const configs: { p: PeriodConfig; o: PayoutConfig }[] = [];
    for (let cutoff = 1; cutoff <= 27; cutoff += 2) {
      for (const [a, b] of [[10, 25], [13, 29], [15, 30], [1, 31], [31, 1], [20, 5], [28, 14], [7, 22]] as const) configs.push({ p: semi(cutoff), o: fixed([a, b]) });
      for (const n of [0, 7, 15, 31]) configs.push({ p: semi(cutoff), o: lag(n) });
    }
    for (const d of [1, 5, 10, 15, 28, 29, 30, 31]) {
      configs.push({ p: monthly, o: fixed([d]) }, { p: weekly, o: fixed([d]) });
    }
    for (const n of [0, 3, 31]) configs.push({ p: monthly, o: lag(n) }, { p: weekly, o: lag(n) });
    expect(configs.length).toBeGreaterThanOrEqual(150);
    const memos = new Map<string, Memo>();
    for (const { p, o } of configs) {
      const key = `${p.payrollPeriodType}-${p.semiMonthlyCutoffDay}`;
      const memo = memos.get(key) ?? new Memo(p);
      memos.set(key, memo);
      expect(memo.truth(o), `${key} ${JSON.stringify(o)}`).toBe(truth(p, o));
    }
  });
});

describe('P1 — maxPayoutGapDays literal table, called with NO date (R11), each row also equal to the independent truth', () => {
  for (const c of TABLE) {
    it(`${c.name} => ${c.expected} days${c.note ? ` (${c.note})` : ''}`, () => {
      expect(gap(c.p, c.o)).toBe(c.expected);
      expect(gap(c.p, c.o), 'vs the independent truth').toBe(truth(c.p, c.o));
    });
  }

  it('returns an INTEGER number of days (a count, never a fraction or NaN)', () => {
    for (const c of TABLE) expect(Number.isInteger(gap(c.p, c.o)), c.name).toBe(true);
  });

  it('a leap-year frame changes nothing for the compliant cadence: [10,25] and lag 0 stay 16 at cutoff 15', () => {
    expect(gap(semi(15), fixed([10, 25]))).toBe(16);
    expect(gap(semi(15), lag())).toBe(16);
  });
});

// =================================================================================================
// A1 — the signature takes no date
// =================================================================================================

describe('A1 — maxPayoutGapDays(periodCfg, payoutCfg): no start parameters, not even defaulted ones', () => {
  it('the parameters are exactly [PeriodConfig, PayoutConfig]', () => {
    // Compile-time: `expectTypeOf` bites under `tsc`/`vitest --typecheck`, not at runtime — a defaulted start parameter would
    // leave `.length` at 2, so the type check is the one that catches it, and `.length` below catches a plain extra one.
    expectTypeOf(periods.maxPayoutGapDays).parameters.toEqualTypeOf<[PeriodConfig, PayoutConfig]>();
    expect(periods.maxPayoutGapDays.length, 'the function still declares start parameters').toBe(2);
  });
});

// =================================================================================================
// G1 — the sweep: production equals the independent truth on every config
// =================================================================================================

describe('G1 — sweep: maxPayoutGapDays === truth across every cadence', () => {
  it(
    'semi-monthly cutoffs 1-27 × every ordered pair [a,b] (a≠b, 1-31) and × lag 0-31, plus monthly and weekly each with [d] and lag 0-31',
    { timeout: 180_000 },
    () => {
      const started = Date.now();
      let checked = 0;
      const mismatch = (label: string, got: number, want: number): never => {
        throw new Error(`FIRST MISMATCH after ${checked} configs: ${label}: maxPayoutGapDays = ${got}, truth = ${want}`);
      };
      const check = (label: string, p: PeriodConfig, o: PayoutConfig, memo: Memo) => {
        const want = memo.truth(o);
        const got = gap(p, o);
        checked += 1;
        if (got !== want) mismatch(label, got, want);
      };

      for (let cutoff = 1; cutoff <= 27; cutoff++) {
        const p = semi(cutoff);
        const memo = new Memo(p);
        for (let a = 1; a <= 31; a++) {
          for (let b = 1; b <= 31; b++) {
            if (a === b) continue;
            check(`semi cutoff ${cutoff} [${a},${b}]`, p, fixed([a, b]), memo);
          }
        }
        for (let n = 0; n <= 31; n++) check(`semi cutoff ${cutoff} lag ${n}`, p, lag(n), memo);
      }
      for (const [name, p] of [['monthly', monthly], ['weekly', weekly]] as const) {
        const memo = new Memo(p);
        for (let d = 1; d <= 31; d++) check(`${name} [${d}]`, p, fixed([d]), memo);
        for (let n = 0; n <= 31; n++) check(`${name} lag ${n}`, p, lag(n), memo);
      }

      console.log(`G1: ${checked} configs checked in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      expect(checked).toBe(27 * (31 * 30 + 32) + 2 * (31 + 32));
    },
  );
});
