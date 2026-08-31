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

/**
 * ⭐ **Minutes become hours in HALF-HOUR STEPS, and the remainder is DROPPED.**
 *
 * Ian, 2026-08-31: *"time must be computed by .5 escalation so hours are .5, 1, 1.5, 2 like that,
 * no hanging minutes except for computation of late."*
 *
 * So 1h50m of overtime pays **1.5 hours**, and 25 minutes pays **nothing** — *"no hanging minutes"*
 * means the leftover is discarded, not rounded up. ⚠️ **That direction is a decision with a
 * consequence**: a store whose overtime is habitually 20 minutes will pay none of it, and the fix
 * for that is to change how overtime is approved, not to round it up quietly here.
 *
 * ⛔ **Late is deliberately NOT stepped.** Ian named it as the exception, and it is the right one:
 * lateness is a measurement of a person's conduct, and rounding 25 minutes late down to zero would
 * erase the fact. `attendance_days.lateMinutes` stays an exact integer minute, untouched by this.
 */
export const HOUR_STEP_MINUTES = 30;

export function steppedHours(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.floor(minutes / HOUR_STEP_MINUTES) / (60 / HOUR_STEP_MINUTES);
}

/** ⚠️ Only `daily` has a compute path here — one of 126 live v1 staff is hourly (T-189 §4). */
export interface DayInput {
  shiftDay: string;
  isHalfDay: boolean;
  otMinutes: number;
  nightDiffMinutes: number;
  holidayMinutes: number;
  computedMinutes: number;
  /** ⭐ Which KIND of holiday, so the right multiplier applies. Null on an ordinary day. */
  holidayType: 'regular' | 'special_non_working' | 'special_working' | null;
  /** The daily rate in force ON THIS DAY. ⭐ Resolved per day, so a mid-period raise pays both. */
  dailyRate: string;
}

export interface Multipliers {
  /** From `store_attendance_config` — the hours a full shift owes, and the divisor for the
   *  hourly equivalent of a daily rate. */
  requiredHoursPerShift: string;

  /**
   * ⭐ T-189b. `multiplier` prices an OT hour as the hourly equivalent × `overtimeMultiplier`.
   * `fixed` REPLACES that with `overtimeFixedHourly` pesos per hour — it multiplies nothing, which
   * is why it is a mode rather than a second number quietly reinterpreted.
   */
  overtimeMode: 'multiplier' | 'fixed';
  overtimeMultiplier: string;
  overtimeFixedHourly: string | null;

  nightDiffMultiplier: string;

  /** ⭐ One per holiday KIND, keyed to `attendance_days.holidayType`. v1 hardcodes 2.0 / 1.3 and
   *  has no third; all three are settings here. */
  holidayRegularMultiplier: string;
  holidaySpecialNonWorkingMultiplier: string;
  holidaySpecialWorkingMultiplier: string;
}

/** ⚠️ An ordinary day never reaches this — `holidayMinutes` is 0, so no premium is computed. */
function holidayMultiplierFor(m: Multipliers, kind: DayInput['holidayType']): number {
  if (kind === 'special_non_working') return Number(m.holidaySpecialNonWorkingMultiplier);
  if (kind === 'special_working') return Number(m.holidaySpecialWorkingMultiplier);
  return Number(m.holidayRegularMultiplier);
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
    //
    // ⭐ FIXED-mode overtime is exempt from that guard, and deliberately: a flat peso amount per
    // hour never divides by the shift length, so a misconfigured `requiredHoursPerShift` has no
    // way to corrupt it and there is no reason to withhold it.
    if (required <= 0) {
      if (m.overtimeMode === 'fixed') {
        const flatHours = steppedHours(day.otMinutes);
        if (flatHours > 0) {
          otMinutes += 0; // already accumulated above
          otPay = add(otPay, multiply(money(m.overtimeFixedHourly ?? '0'), factor(flatHours)));
        }
      }
      continue;
    }

    // ⭐ Minutes become hours in HALF-HOUR STEPS, remainder dropped — `steppedHours`. 1h50m of
    // overtime is 1.5 hours; 25 minutes is none. ⛔ Late is NOT stepped, and is not computed here.
    const otHours = steppedHours(day.otMinutes);
    const ndHours = steppedHours(day.nightDiffMinutes);
    const holHours = steppedHours(day.holidayMinutes);

    if (otHours > 0) {
      // ⭐ `fixed` REPLACES the rate rather than multiplying it: a flat peso amount per OT hour.
      otPay =
        m.overtimeMode === 'fixed'
          ? add(otPay, multiply(money(m.overtimeFixedHourly ?? '0'), factor(otHours)))
          : add(otPay, multiply(rate, factor((otHours / required) * otMult)));
    }
    if (ndHours > 0) {
      nightDiffPay = add(nightDiffPay, multiply(rate, factor((ndHours / required) * (ndMult - 1))));
    }
    if (holHours > 0) {
      // ⭐ The multiplier depends on WHICH holiday — regular, special non-working, special working.
      const holMult = holidayMultiplierFor(m, day.holidayType);
      holidayPay = add(holidayPay, multiply(rate, factor((holHours / required) * (holMult - 1))));
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
