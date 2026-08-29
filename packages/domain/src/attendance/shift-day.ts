/**
 * The shift-day calendar: 05:00 → 05:00 Manila. T-155 Part A.
 * `docs/tasks/155-shift-day-and-attendance-config.md`, `docs/plans/phase-4-attendance.md` §4.3.
 *
 * ## The rule, from v1 (`ERP-rebuild/src/lib/attendance/shift-day.ts:3-6`), verbatim
 *
 * > *"A shift day runs 05:00 → 05:00 PHT, not midnight → midnight: a closing staffer who taps out
 * > at 01:30 belongs to the day they started, not the calendar day the clock rolled into. Every
 * > attendance session is anchored to this, which is why `AttendanceSessionPlain.sessionDate` is
 * > called sessionDate and not dayKey — **the financial dayKey is a different, midnight-based
 * > thing.**"*
 *
 * ⭐ v1 named its two calendars differently on purpose and wrote down why. That comment is the most
 * useful line in the module, and it is why this lives in its own file with its own branded type.
 *
 * ## ⛔ Why this is NOT in `packages/core/src/datetime.ts`
 *
 * That module answers the question itself, in its own header:
 *
 * > *"If a module needs a different cut-off (a sales day that closes at 4am, say), that belongs in
 * > **that module as an explicit, named rule** — not as a quiet change to this function."*
 *
 * So the rule lives here, **built on** core's primitives rather than re-deriving them: there is
 * still exactly one timezone definition, one parser, one formatter (bible §12 landmine 26 — *"v1 had
 * FOUR coexisting date idioms… There is exactly one here. Do not add a second"*). What is added is
 * one named, local decision about where a day is cut.
 *
 * ⚠️ Putting a 05:00 variant beside `toBusinessDate` in core is how a payroll query silently uses
 * the wrong one a year from now. The symptom would be a pay difference on overnight shifts only.
 * `ShiftDay` is therefore a **separate brand** from `BusinessDate`: swapping them does not compile.
 */
import {
  addDays,
  businessDayRange,
  parseBusinessDate,
  toBusinessDate,
  type BusinessDate,
} from '@shareat/core/datetime';

const HOUR_MS = 3_600_000;

/** Where the attendance day is cut. Not midnight, and not negotiable per store — see the header. */
export const SHIFT_DAY_START_HOUR = 5;

/**
 * A shift day in the business timezone, `YYYY-MM-DD`.
 *
 * ⛔ **Deliberately NOT interchangeable with `BusinessDate`.** They are both `YYYY-MM-DD` strings
 * and they mean different days for the same instant between 00:00 and 05:00 — which is precisely
 * when closing staff clock out. The brands make that a compile error instead of a payroll defect.
 */
export type ShiftDay = string & { readonly __brand: 'ShiftDay' };

/**
 * The shift day an instant belongs to.
 *
 * Shifting the instant back by five hours and then asking core which business date it lands on
 * means the zone offset is resolved by core's zone-database lookup, not by a constant here. The
 * Philippines has had a fixed +08:00 since 1978; this does not depend on that staying true.
 */
export function toShiftDay(instant: Date = new Date()): ShiftDay {
  return toBusinessDate(new Date(instant.getTime() - SHIFT_DAY_START_HOUR * HOUR_MS)) as string as ShiftDay;
}

/** Parse a `YYYY-MM-DD` shift day, rejecting anything malformed rather than coercing it. */
export function parseShiftDay(value: string): ShiftDay {
  return parseBusinessDate(value) as string as ShiftDay;
}

/**
 * The UTC instant range covering one shift day: `[start, end)`.
 *
 * Half-open, like `businessDayRange`, so a punch at the boundary is counted once and only once.
 * The end is derived as the NEXT day's start rather than `start + 24h`, so a hypothetical offset
 * change could never produce a 23- or 25-hour day that silently drops or double-counts an hour.
 */
export function shiftDayRange(day: ShiftDay): { start: Date; end: Date } {
  const midnightOf = (d: BusinessDate) => businessDayRange(d).start.getTime();
  const asBusiness = day as string as BusinessDate;
  const offset = SHIFT_DAY_START_HOUR * HOUR_MS;
  return {
    start: new Date(midnightOf(asBusiness) + offset),
    end: new Date(midnightOf(addDays(asBusiness, 1)) + offset),
  };
}

export function addShiftDays(day: ShiftDay, days: number): ShiftDay {
  return addDays(day as string as BusinessDate, days) as string as ShiftDay;
}

/**
 * Where a wall-clock hour sits within the shift day, in ms from its 05:00 start.
 * `05:00 → 0`, `18:00 → 13h`, `01:00 → 20h`.
 *
 * ⭐ **This ordering is the point, not a convenience.** v1's own comment
 * (`shift-day.ts:44-50`): *"it is what lets a store whose shifts start at 18:00 compare an 01:00 tap
 * correctly: 01:00 comes AFTER 18:00 within one shift day, even though 1 < 18 as a number."*
 * Comparing raw hours gets a store with overnight shifts backwards, and the failure presents as the
 * start anchor picking the wrong shift rather than as a sorting bug.
 */
export function shiftDayOffsetMsForHour(hour: number): number {
  return ((((hour - SHIFT_DAY_START_HOUR) % 24) + 24) % 24) * HOUR_MS;
}
