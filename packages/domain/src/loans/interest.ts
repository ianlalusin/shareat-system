/**
 * Loan interest and how a payment splits. T-126 §4.
 *
 * ## ⭐ v1 leaves this to whoever types the number
 *
 * Its builder takes the principal/interest split **from the caller** — *"interest is cash-basis,
 * recognised at payment time from the split provided by the caller"* — with a `suggestPaymentSplit`
 * helper the caller may ignore. So the figure deciding how fast a debt retires is hand-entered.
 * Here it is computed, and the computation is pure so it can be checked without a database.
 *
 * ## ⚠️ A month is 30 days and a year is 365 — they are not interchangeable
 *
 * v1 learned this the hard way and wrote it down: a rate quoted 2% *monthly* (how Grab quotes) and
 * one quoted 2% *annually* differ by more than twelve-fold in effect, and nothing on the number
 * itself says which it is. That is why `ratePeriod` is carried on every loan and is **NOT NULL**.
 */
import { add, compare, fromCentavos, money, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';

export type RatePeriod = 'day' | 'month' | 'year';
export type InterestMethod = 'straight' | 'amortizing' | 'equal_principal';

/** v1's own conversion basis, ported deliberately rather than re-derived. */
const DAYS_IN = { day: 1, month: 30, year: 365 } as const;

/** The rate as a plain daily fraction. `2` at `month` → 0.02 / 30. */
export function dailyRate(ratePercent: number, period: RatePeriod): number {
  return ratePercent / 100 / DAYS_IN[period];
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export interface AccruedInput {
  /** What is still owed — ⚠️ the CURRENT balance, not the original principal. */
  outstanding: Money;
  /** The rate as STORED (`loans.interest_rate`, e.g. `'2.0000'`). ⛔ A string on purpose: a `number` is a float, and a float rate is how a centavo moved (DEF-841). */
  ratePercent: string;
  ratePeriod: RatePeriod;
  method: InterestMethod;
  /** Original principal. Only `straight` needs it (see below). */
  principal: Money;
  /** Last payment date, or the loan's start date if none. */
  since: string;
  until: string;
}

/**
 * Interest accrued between two dates.
 *
 * ⭐ **Exact (T-573, DEF-841):** `base × rate% × days ÷ (100 × days-in-period)` in scaled bigint — centavos × the rate's digits —
 * with ONE rounding step at the end, **half-up to the centavo** (a tie such as 0.365 becomes 0.37). No float touches the money or the rate.
 *
 * ⭐ **The methods differ in what the rate is charged ON, and that is the whole distinction:**
 *
 * - `straight` — on the **original principal**, always. Paying early does not reduce the interest,
 *   which is why the total cost is fixed the day it is signed. This is how Grab's loans work.
 * - `amortizing` / `equal_principal` — on the **outstanding balance**, so retiring principal sooner
 *   genuinely costs less. ⚠️ Which is why `paymentFrequency` changes the total interest for these
 *   two and never for `straight`, a distinction v1 documents and it would be easy to lose.
 */
export function accruedInterest(input: AccruedInput): Money {
  const days = daysBetween(input.since, input.until);
  if (days <= 0) return money('0');

  const base = input.method === 'straight' ? input.principal : input.outstanding;
  // T-371 C4: ordered in scaled bigint on the brand, never as a float.
  if (compare(base, ZERO) <= 0) return money('0');

  const rate = /^(\d+)(?:\.(\d+))?$/.exec(input.ratePercent);
  if (!rate) throw new Error(`accruedInterest: the rate "${input.ratePercent}" is not a plain non-negative decimal.`);
  const [, whole = '0', fraction = ''] = rate;
  const numerator = toCentavos(base) * BigInt(whole + fraction) * BigInt(days);
  const denominator = 100n * 10n ** BigInt(fraction.length) * BigInt(DAYS_IN[input.ratePeriod]);
  return fromCentavos((2n * numerator + denominator) / (2n * denominator)); // half-up: floor(n/d + 1/2)
}

/**
 * DEF-896: the interest actually still OWED = what has built up over the run, less what interest-only part-payments have
 * already covered in it. Floored at zero (a payment can never leave a negative amount owed). Pure, integer centavos.
 */
export function interestDue(accrued: Money, paidSince: Money): Money {
  const left = subtract(accrued, paidSince);
  return compare(left, ZERO) < 0 ? money('0') : left;
}

export interface SplitInput {
  /** What arrived. ⚠️ Rarely the scheduled instalment — see below. */
  payment: Money;
  outstanding: Money;
  accrued: Money;
}

export interface PaymentSplit {
  interest: Money;
  principal: Money;
  /** ⚠️ Anything beyond interest AND the whole remaining principal. Never silently absorbed. */
  overpayment: Money;
}

/**
 * Splits a payment: **interest first, principal second.**
 *
 * ⭐ **This handles the normal case, not the tidy one.** Real payments do not follow the schedule —
 * *"the history shows Grab repeatedly deducting less than the instalment when the day's net is
 * small"* — so "an arbitrary amount arrived" is what actually happens, and a function that only
 * knows how to apply a scheduled instalment would be wrong most days.
 *
 * ⛔ **Principal can never exceed what is outstanding.** A payment bigger than the debt is an
 * overpayment — money the lender owes back — not a negative loan, and it is returned separately so
 * the caller has to decide what to do with it rather than having it vanish into principal.
 */
export function splitPayment(input: SplitInput): PaymentSplit {
  // T-371 C4 / RULES §6: the split is integer centavos end to end — the brands are ordered with `compare`, and the
  // arithmetic is bigint, so no float rounding can move a centavo between interest and principal.
  if (compare(input.payment, ZERO) <= 0) return { interest: money('0'), principal: money('0'), overpayment: money('0') };
  const pay = toCentavos(input.payment);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const nonNegative = (v: Money) => (compare(v, ZERO) > 0 ? toCentavos(v) : 0n);

  // Interest first — the standard order, and the one that stops a small payment from looking like
  // it retired debt when it only serviced the cost of carrying it.
  const interest = min(pay, nonNegative(input.accrued));
  const afterInterest = pay - interest;
  const principal = min(afterInterest, nonNegative(input.outstanding));
  const overpayment = afterInterest - principal;

  return {
    interest: fromCentavos(interest),
    principal: fromCentavos(principal),
    overpayment: fromCentavos(overpayment),
  };
}

export interface InstalmentInput {
  principal: Money;
  ratePercent: number;
  ratePeriod: RatePeriod;
  method: InterestMethod;
  /** How many instalments. */
  periods: number;
  /** Days each instalment covers — 1 daily, 7 weekly, 30 monthly. */
  daysPerPeriod: number;
}

/**
 * The scheduled instalment — for display and for a due-date reminder, **not** for splitting a
 * payment that has already arrived.
 *
 * ⚠️ Kept separate from `splitPayment` on purpose: conflating "what was due" with "what turned up"
 * is how a register ends up asserting a debt was serviced on a day nobody paid.
 */
export function scheduledInstalment(input: InstalmentInput): Money {
  // T-371 C4: the guard orders the brand, not its float.
  if (compare(input.principal, ZERO) <= 0 || input.periods < 1) return money('0');
  const p = Number(input.principal);

  const r = dailyRate(input.ratePercent, input.ratePeriod) * input.daysPerPeriod;

  if (input.method === 'straight') {
    // Interest on the original principal for the whole term, spread evenly.
    const total = p + p * r * input.periods;
    return money((total / input.periods).toFixed(2));
  }

  if (input.method === 'equal_principal') {
    // ⚠️ The FIRST instalment, which is the largest — later ones shrink as the balance does. A
    // single number cannot describe this method honestly, so it reports the one a borrower needs
    // to be able to afford.
    return money((p / input.periods + p * r).toFixed(2));
  }

  // Amortizing: the standard annuity. r = 0 degenerates to straight-line, and dividing by zero
  // there is the classic way this formula blows up.
  if (r === 0) return money((p / input.periods).toFixed(2));
  const factor = Math.pow(1 + r, input.periods);
  return money(((p * r * factor) / (factor - 1)).toFixed(2));
}

/** Sums a list of money strings without touching floats twice. */
export function totalOf(amounts: readonly Money[]): Money {
  return amounts.reduce((sum, a) => add(sum, a), money('0'));
}

/** Cost less what has been repaid. Exported so the repo and the screens agree on the subtraction. */
export function remainingOf(principal: Money, principalPaid: Money): Money {
  return subtract(principal, principalPaid);
}

// -------------------------------------------------------------------------------------
// T-608 (DEF-931): a platform dock on a SCHEDULED loan splits into principal and interest
// -------------------------------------------------------------------------------------

/** A scheduled loan: `total` = what the agreement repays in all (`repayment_amount x term_periods`), `interest` = `total - principal`, both in centavos. */
export interface LoanSchedule {
  total: bigint;
  interest: bigint;
}

/**
 * The schedule of a loan, or null when it has none: no repayment amount, no term, or a schedule that repays no more than was borrowed.
 * A loan with no schedule keeps the old behaviour (a platform dock is all principal).
 */
export function loanSchedule(loan: { principalAmount: string; repaymentAmount: string | null; termPeriods: number }): LoanSchedule | null {
  if (loan.repaymentAmount === null || !(loan.termPeriods > 0)) return null;
  const total = toCentavos(money(loan.repaymentAmount)) * BigInt(loan.termPeriods);
  const interest = total - toCentavos(money(loan.principalAmount));
  return interest > 0n ? { total, interest } : null;
}

/** What a scheduled loan still has to pay, principal plus interest, in centavos: `total - (principal paid + interest paid)`, never below zero; nothing before the loan is drawn. */
export function leftToPay(schedule: LoanSchedule, position: { disbursed: string; principalPaid: string; interestPaid: string }): bigint {
  if (toCentavos(money(position.disbursed)) <= 0n) return 0n;
  const left = schedule.total - (toCentavos(money(position.principalPaid)) + toCentavos(money(position.interestPaid)));
  return left > 0n ? left : 0n;
}

/**
 * How one platform dock (`leg`, centavos) splits on a scheduled loan. Interest is worked CUMULATIVELY, so rounding never drifts, the last payment lands exactly,
 * and a loan whose earlier docks were all booked as principal catches up on its next one:
 * `interest = clamp(roundHalfUp(min(paidBefore + leg, total) x I / T) - interestBefore, 0, leg)`, `principal = leg - interest`.
 * `paidBefore` is principal paid + interest paid so far and `interestBefore` the interest already booked, both from the ledger. All integer centavos.
 */
export function splitSettlementLeg(schedule: LoanSchedule | null, leg: bigint, paidBefore: bigint, interestBefore: bigint): { principal: bigint; interest: bigint } {
  if (schedule === null || leg <= 0n) return { principal: leg, interest: 0n };
  const target = paidBefore + leg < schedule.total ? paidBefore + leg : schedule.total; // shortcut: a dock past the total pays no interest beyond I, the excess stays principal as today; capping a leg at the balance is a separate task
  const owed = (2n * target * schedule.interest + schedule.total) / (2n * schedule.total) - interestBefore; // half-up
  const interest = owed < 0n ? 0n : owed > leg ? leg : owed;
  return { principal: leg - interest, interest };
}
