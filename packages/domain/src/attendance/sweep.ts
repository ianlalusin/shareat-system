/**
 * T-199 — closing a shift nobody clocked out of.
 *
 * ⭐ **The rule that matters most, copied verbatim from v1 with its reasoning:**
 *
 * > *"The staffer is clocked out, but the time is not captured. Nobody observed them leaving, so
 * > no `rawClockOut` is written and the session is closed as `missing_out` — after which
 * > `halfDayOnMissingTap` decides what it pays. **Inventing a clock-out time would put a number
 * > nobody witnessed into the audit record.**"*
 *
 * ⭐ **v2 does LESS work than v1 to honour it, and that is the design.** v1 closes a *session* and
 * must decide what to write into it. v2 has punches and a derived day: an `in` with no `out` is
 * **already** `missing_out`, and `resolveStatus` already calls it `open`. So this sweep **writes no
 * punch at all** — it settles the STATUS, saying "this day is finished; it will never get an out".
 *
 * ⛔ Two rules produce the same situation and must produce the **same record**, because a day
 * settled by the sweep must not be distinguishable-by-accident depending on which rule caught it.
 */
import { attendanceDaysRepo, type Tx } from '@shareat/db';
import { sql } from 'drizzle-orm';

/**
 * ⛔ **How long a day must have been open before the wall-clock rule will close it.**
 *
 * v1's comment earns its place and the reasoning is a money argument, not tidiness:
 *
 * > *"Without this, a store whose cutoff hour sits near a real shift start would kill a shift that
 * > had just begun — and with `halfDayOnMissingTap` on, **pay it half a day for five minutes of
 * > work.**"*
 *
 * ⚠️ Note the shape: it is DEF-088 and DEF-111's family again — a rule that turns *a few minutes
 * present* into *money*. Anything this skips is caught by the next hour's sweep or by the
 * `maxShiftHours` backstop, so the guard costs nothing at all.
 */
export const MIN_OPEN_MINUTES = 60;

export interface SweepPolicy {
  /** `null` = this store never auto-clears. The state every store is in before anyone opts in. */
  autoClockOutHour: number | null;
  maxShiftHours: number;
}

export interface OpenDayFacts {
  /** Minutes from the start of its shift day to the first `in`. */
  anchorMinute: number | null;
  /** Minutes the day has been open, measured to now. */
  openMinutes: number;
}

export type SweepVerdict =
  | { close: false; why: 'not_due' | 'too_fresh' | 'never_clears' }
  | { close: true; why: 'cutoff_hour' | 'max_shift' };

/**
 * ⭐ **PURE — no database, no clock.** The sweep and its tests share one answer, exactly as v1's
 * `auto-clock-out.ts` is pure for the same reason.
 *
 * @param minutesSinceCutoff how long ago this store's cutoff hour last passed, or `null` when the
 *   store never auto-clears. Computed by the caller, which owns the timezone.
 */
export function verdictFor(
  day: OpenDayFacts,
  policy: SweepPolicy,
  minutesSinceCutoff: number | null,
): SweepVerdict {
  // ⛔ The backstop is checked FIRST and is independent of the hour: a day open longer than the cap
  // was forgotten, and a store that never auto-clears still should not carry a two-day shift.
  if (day.openMinutes >= policy.maxShiftHours * 60) return { close: true, why: 'max_shift' };

  if (policy.autoClockOutHour === null || minutesSinceCutoff === null) {
    return { close: false, why: 'never_clears' };
  }
  // The cutoff has not come round since this day opened.
  if (day.openMinutes < minutesSinceCutoff) return { close: false, why: 'not_due' };
  if (day.openMinutes < MIN_OPEN_MINUTES) return { close: false, why: 'too_fresh' };

  return { close: true, why: 'cutoff_hour' };
}

/**
 * ⭐ **How long ago the store's cutoff hour last passed**, in minutes, in Asia/Manila.
 *
 * ⚠️ Pinned to the business timezone rather than the server's, for the reason T-198's migration
 * gives: a production host running UTC is eight hours behind Manila, and a cutoff evaluated in UTC
 * would fire at the wrong time of day every single night.
 */
export function minutesSinceCutoff(hour: number | null, nowMs: number): number | null {
  if (hour === null) return null;
  const manila = new Date(nowMs + 8 * 3_600_000);
  const minutesToday = manila.getUTCHours() * 60 + manila.getUTCMinutes();
  const cutoff = hour * 60;
  return minutesToday >= cutoff ? minutesToday - cutoff : minutesToday + 1440 - cutoff;
}

export interface SweptDay {
  dayId: string;
  personName: string;
  shiftDay: string;
  why: 'cutoff_hour' | 'max_shift';
}

/**
 * Settle every open day at one store that the rules say is finished.
 *
 * ⛔ **No `authorize()` and no `Actor`.** T-140's decision, unchanged: *"the scheduler acts as a
 * `system` principal and never manufactures a person"* — a service person holding an admin role is
 * a standing credential nobody watches. The narrow control is that this function can do exactly
 * one thing.
 */
export async function sweepStore(
  tx: Tx,
  input: { storeId: string; nowMs: number },
): Promise<{ swept: SweptDay[]; leftOpen: number }> {
  const config = await tx.execute(sql`
    select auto_clock_out_hour as "autoClockOutHour", max_shift_hours as "maxShiftHours"
    from store_attendance_config
    where store_id = ${input.storeId} and superseded_at is null`);
  const policy = (config as unknown as SweepPolicy[])[0];
  if (!policy) return { swept: [], leftOpen: 0 };

  const rows = (await tx.execute(sql`
    select d.id::text as "id", d.shift_day::text as "shiftDay", d.anchor_minute as "anchorMinute",
           p.display_name as "personName",
           -- ⭐ Open-for, in minutes, measured from the first punch rather than from the shift day's
           -- start: a day that opened at 22:00 has been open two hours at midnight, not twenty-two.
           --
           -- ⛔ Measured against the CALLER'S clock, not the database's own now(). Two clocks in
           -- one decision is how a rule becomes untestable and then untrue: verdictFor already
           -- takes nowMs, and a query quietly using its own now() would disagree with it on any
           -- run that straddles a second — and could never be tested at a chosen time.
           -- ⚠️ No backticks in here: this is inside a template literal and one would close it.
           (extract(epoch from (to_timestamp(${input.nowMs} / 1000.0) - min(pu.occurred_at))) / 60)::int as "openMinutes"
      from attendance_days d
      join employments e on e.id = d.employment_id
      join persons p on p.id = e.person_id
      join attendance_punches pu on pu.employment_id = d.employment_id and pu.shift_day = d.shift_day
     where d.store_id = ${input.storeId}
       and d.status = 'open'
       and d.frozen_at is null
     group by d.id, d.shift_day, d.anchor_minute, p.display_name`)) as unknown as (OpenDayFacts & {
    id: string;
    shiftDay: string;
    personName: string;
  })[];

  const sinceCutoff = minutesSinceCutoff(policy.autoClockOutHour, input.nowMs);
  const swept: SweptDay[] = [];
  let leftOpen = 0;

  for (const row of rows) {
    const verdict = verdictFor(row, policy, sinceCutoff);
    if (!verdict.close) {
      leftOpen++;
      continue;
    }
    /**
     * ⛔ **`needs_review`, and no punch is written.** The day joins T-195's queue, where a manager
     * is the only thing that can settle it — `resolveStatus` deliberately refuses to promote a
     * `needs_review` day on recompute, which is exactly what makes this destination stick.
     */
    await attendanceDaysRepo.markNeedsReview(tx, row.id, verdict.why);
    swept.push({ dayId: row.id, personName: row.personName, shiftDay: row.shiftDay, why: verdict.why });
  }

  return { swept, leftOpen };
}
