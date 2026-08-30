/**
 * What a payslip is worth. T-189 §6. **Pure — no database, no clock, no I/O.**
 *
 * ⭐ Kept separate from the service on purpose: this is the part that decides somebody's money, so
 * it must be testable without a fixture and reviewable without reading a transaction.
 *
 * ⚠️ **Every peso goes through `@shareat/core/money`**, which is exact bigint centavo arithmetic
 * with round-half-up. Bible §6 bans floats for money, and a payslip is the last place to start.
 */
import { ZERO, add, compare, money, multiply, type Money } from '@shareat/core/money';

/** ⚠️ Only `daily` has a compute path here — one of 126 live v1 staff is hourly (T-189 §4). */
export interface DayInput {
  shiftDay: string;
  isHalfDay: boolean;
  otMinutes: number;
  nightDiffMinutes: number;
  holidayMinutes: number;
  computedMinutes: number;
  /** The daily rate in force ON THIS DAY. ⭐ Resolved per day, so a mid-period raise pays both. */
  dailyRate: string;
}

export interface Multipliers {
  /** From `store_attendance_config` — the hours a full shift owes, and the divisor for the
   *  hourly equivalent of a daily rate. */
  requiredHoursPerShift: string;
  overtimeMultiplier: string;
  nightDiffMultiplier: string;
  /** ⚠️ Not in `store_attendance_config` yet. v1 hardcodes 2.0 regular / 1.3 special; the caller
   *  passes it so the day it becomes configurable, nothing here changes. */
  holidayMultiplier: string;
}

export interface ComputedPay {
  daysWorked: number;
  minutesWorked: number;
  otMinutes: number;
  nightDiffMinutes: number;
  holidayMinutes: number;
  basicPay: Money;
  otPay: Money;
  nightDiffPay: Money;
  holidayPay: Money;
  grossPay: Money;
}

/**
 * A plain number as a decimal string `multiply` will accept.
 *
 * ⚠️ `multiply` rejects exponent notation, which `String(1e-7)` produces — so this fixes to 10
 * places. That is far finer than a centavo; the exact rounding happens once, inside `multiply`.
 */
function factor(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  return n.toFixed(10);
}

/**
 * ⭐ **A half day pays HALF THE DAILY RATE, never the hours covered.**
 *
 * A locked v1 decision, and it was a *fix* rather than a simplification: hourly half-days used to
 * pay `computedHours × rate` — 5h against a 9h day — but the 5h half-day block is 4 work + 1 paid
 * break while the 9h shift is 8 + 1, so half the break was being paid twice. ⛔ Do not "correct"
 * this back to hours.
 */
function unitsFor(day: DayInput): number {
  return day.isHalfDay ? 0.5 : 1;
}

/**
 * Adds up a period for ONE employment.
 *
 * ⚠️ **Night-diff and holiday are ADD-ONS** — `× (multiplier − 1)` — because the hour is already
 * paid once inside the daily rate. Paying `× multiplier` would pay the base hour twice, and v1
 * records this as easy to get wrong. **Overtime is not an add-on**: OT minutes fall outside the
 * normal shift, so they pay the full multiplier.
 */
export function computePay(days: DayInput[], m: Multipliers): ComputedPay {
  const required = Number(m.requiredHoursPerShift);
  const otMult = Number(m.overtimeMultiplier);
  const ndMult = Number(m.nightDiffMultiplier);
  const holMult = Number(m.holidayMultiplier);

  let daysWorked = 0;
  let minutesWorked = 0;
  let otMinutes = 0;
  let nightDiffMinutes = 0;
  let holidayMinutes = 0;
  let basicPay = ZERO;
  let otPay = ZERO;
  let nightDiffPay = ZERO;
  let holidayPay = ZERO;

  for (const day of days) {
    const rate = money(day.dailyRate);
    const units = unitsFor(day);

    daysWorked += units;
    minutesWorked += day.computedMinutes;
    otMinutes += day.otMinutes;
    nightDiffMinutes += day.nightDiffMinutes;
    holidayMinutes += day.holidayMinutes;

    basicPay = add(basicPay, multiply(rate, factor(units)));

    // ⚠️ Guard the divisor. A store configured with 0 required hours would otherwise turn every
    // premium into Infinity, and the CHECK constraints would reject the payslip with a message
    // about an identity rather than about the misconfiguration that caused it.
    if (required <= 0) continue;

    if (day.otMinutes > 0) {
      otPay = add(otPay, multiply(rate, factor((day.otMinutes / 60 / required) * otMult)));
    }
    if (day.nightDiffMinutes > 0) {
      nightDiffPay = add(
        nightDiffPay,
        multiply(rate, factor((day.nightDiffMinutes / 60 / required) * (ndMult - 1))),
      );
    }
    if (day.holidayMinutes > 0) {
      holidayPay = add(
        holidayPay,
        multiply(rate, factor((day.holidayMinutes / 60 / required) * (holMult - 1))),
      );
    }
  }

  return {
    daysWorked,
    minutesWorked,
    otMinutes,
    nightDiffMinutes,
    holidayMinutes,
    basicPay,
    otPay,
    nightDiffPay,
    holidayPay,
    grossPay: add(basicPay, otPay, nightDiffPay, holidayPay),
  };
}

/**
 * ⛔ **How much of an outstanding advance this payslip recovers.**
 *
 * Capped at gross, never more: net may reach zero and may never go below. A person who owes more
 * than they earned this period keeps owing the rest on `1230` — a thin payslip does not forgive
 * the debt, and it is never allowed to turn a payslip into a bill.
 */
export function advanceToRecover(gross: Money, outstanding: Money): Money {
  if (compare(outstanding, ZERO) <= 0) return ZERO;
  if (compare(gross, ZERO) <= 0) return ZERO;
  return compare(outstanding, gross) > 0 ? gross : outstanding;
}
