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
import { add, money, subtract, type Money } from '@shareat/core/money';

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
  ratePercent: number;
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
  if (Number(base) <= 0) return money('0');

  const amount = Number(base) * dailyRate(input.ratePercent, input.ratePeriod) * days;
  return money(amount.toFixed(2));
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
  const pay = Number(input.payment);
  if (pay <= 0) return { interest: money('0'), principal: money('0'), overpayment: money('0') };

  // Interest first — the standard order, and the one that stops a small payment from looking like
  // it retired debt when it only serviced the cost of carrying it.
  const interest = Math.min(pay, Math.max(0, Number(input.accrued)));
  const afterInterest = pay - interest;
  const principal = Math.min(afterInterest, Math.max(0, Number(input.outstanding)));
  const overpayment = afterInterest - principal;

  return {
    interest: money(interest.toFixed(2)),
    principal: money(principal.toFixed(2)),
    overpayment: money(overpayment.toFixed(2)),
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
  const p = Number(input.principal);
  if (p <= 0 || input.periods < 1) return money('0');

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
