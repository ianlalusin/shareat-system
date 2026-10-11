/**
 * The only place SQL is written for adjudicated days. T-157.
 *
 * ⛔ No `update` that sets computed columns on a frozen day exists here — the trigger refuses it,
 * and a repo function offering it would only be a way to find that out at runtime.
 */
import { and, asc, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { toBusinessDate } from '@shareat/core/datetime';
import type { Tx } from '../client';
import {
  attendanceDays,
  type AttendanceDayStatus,
  type HolidayType,
} from '../../schema/attendance-days';

export interface AttendanceDayRow {
  id: string;
  orgId: string;
  storeId: string;
  personId: string;
  employmentId: string;
  shiftDay: string;
  attendanceConfigId: string;
  firstInPunchId: string | null;
  lastOutPunchId: string | null;
  anchorMinute: number | null;
  anchorMode: 'exact' | 'previous' | 'next' | 'unallowed';
  endMinute: number | null;
  computedMinutes: number;
  isHalfDay: boolean;
  cappedAtRequired: boolean;
  lateMinutes: number;
  lateChargeableMinutes: number;
  earlyOutMinutes: number;
  undertimeForgivenMinutes: number;
  breakMinutes: number;
  allowableBreakMinutes: number;
  breakOverMinutes: number;
  nightDiffMinutes: number;
  isHoliday: boolean;
  holidayType: HolidayType | null;
  holidayMinutes: number;
  pendingOtMinutes: number;
  status: AttendanceDayStatus;
  anomalies: string[];
  explain: string[];
  computedAt: Date;
  computedFromPunchCount: number;
  frozenAt: Date | null;
  frozenByPayRunId: string | null;
}

export type UpsertDayInput = Omit<
  AttendanceDayRow,
  'id' | 'computedAt' | 'frozenAt' | 'frozenByPayRunId'
>;

export async function findDay(
  tx: Tx,
  input: { employmentId: string; shiftDay: string },
): Promise<AttendanceDayRow | undefined> {
  const [row] = await tx
    .select()
    .from(attendanceDays)
    .where(and(eq(attendanceDays.employmentId, input.employmentId), eq(attendanceDays.shiftDay, input.shiftDay)))
    .limit(1);
  return row as AttendanceDayRow | undefined;
}

/**
 * Insert or replace the derived row for one person-day.
 *
 * ⚠️ `updatedAt` is set only when something actually changed, so invariant 10 (recomputing an
 * unchanged day is idempotent) is observable rather than merely claimed.
 */
export async function upsertDay(tx: Tx, input: UpsertDayInput): Promise<AttendanceDayRow> {
  const [row] = await tx
    .insert(attendanceDays)
    .values(input)
    .onConflictDoUpdate({
      target: [attendanceDays.employmentId, attendanceDays.shiftDay],
      set: {
        attendanceConfigId: input.attendanceConfigId,
        firstInPunchId: input.firstInPunchId,
        lastOutPunchId: input.lastOutPunchId,
        anchorMinute: input.anchorMinute,
        anchorMode: input.anchorMode,
        endMinute: input.endMinute,
        computedMinutes: input.computedMinutes,
        isHalfDay: input.isHalfDay,
        cappedAtRequired: input.cappedAtRequired,
        lateMinutes: input.lateMinutes,
        lateChargeableMinutes: input.lateChargeableMinutes,
        earlyOutMinutes: input.earlyOutMinutes,
        undertimeForgivenMinutes: input.undertimeForgivenMinutes,
        breakMinutes: input.breakMinutes,
        allowableBreakMinutes: input.allowableBreakMinutes,
        breakOverMinutes: input.breakOverMinutes,
        nightDiffMinutes: input.nightDiffMinutes,
        isHoliday: input.isHoliday,
        holidayType: input.holidayType,
        holidayMinutes: input.holidayMinutes,
        pendingOtMinutes: input.pendingOtMinutes,
        status: input.status,
        anomalies: input.anomalies,
        explain: input.explain,
        computedAt: new Date(),
        computedFromPunchCount: input.computedFromPunchCount,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as AttendanceDayRow;
}

export async function listDays(
  tx: Tx,
  input: { storeId: string; from: string; to: string },
): Promise<AttendanceDayRow[]> {
  const rows = await tx
    .select()
    .from(attendanceDays)
    .where(
      and(
        eq(attendanceDays.storeId, input.storeId),
        gte(attendanceDays.shiftDay, input.from),
        lte(attendanceDays.shiftDay, input.to),
      ),
    )
    .orderBy(asc(attendanceDays.shiftDay));
  return rows as AttendanceDayRow[];
}

/**
 * ⭐ **T-195.** A day plus the person it belongs to and the live decisions standing on it.
 *
 * `listDays` returns bare rows, which is enough for a recompute and useless for a screen: a
 * manager needs a NAME, and needs to know whether somebody has already decided this day.
 */
export interface ReviewDayRow extends AttendanceDayRow {
  personName: string;
  /** ⭐ The live `overtime_approved` decision. `null` means NOBODY HAS DECIDED, which is not the
   *  same as a decision of zero — the distinction DEF-109's fix rests on. */
  approvedOtMinutes: number | null;
  /** Whether a live decision of each kind stands. Drives "already decided" on the screen. */
  hasStartAnchor: boolean;
  hasEarlyOut: boolean;
  hasHalfDayOverride: boolean;
}

/**
 * ⭐ **Why a day is waiting on a human.** Returned per row so the screen never shows a list
 * without a reason — a queue you cannot interpret is the `needs_review` status all over again.
 */
export type ReviewReason =
  | 'needs_review'
  | 'open'
  | 'unapproved_overtime'
  | 'held_zero_credit';

export interface QueuedDay extends ReviewDayRow {
  reasons: ReviewReason[];
}

const REVIEW_SELECT = sql`
  d.*,
  p.display_name as "personName",
  adj_ot.approved_ot_minutes as "approvedOtMinutes",
  (adj_anchor.id is not null) as "hasStartAnchor",
  (adj_out.id is not null) as "hasEarlyOut",
  (adj_half.id is not null) as "hasHalfDayOverride"
`;

/**
 * ⚠️ Every join is to the LIVE decision only — `superseded_by_adjustment_id is null`. A second
 * decision replaces the first; it does not add to it, and a screen showing both would show a
 * manager their own overwritten choice as though it still stood.
 */
const REVIEW_JOINS = sql`
  from attendance_days d
  join employments e on e.id = d.employment_id
  join persons p on p.id = e.person_id
  left join attendance_adjustments adj_ot
    on adj_ot.employment_id = d.employment_id and adj_ot.shift_day = d.shift_day
   and adj_ot.kind = 'overtime_approved' and adj_ot.superseded_by_adjustment_id is null
  left join attendance_adjustments adj_anchor
    on adj_anchor.employment_id = d.employment_id and adj_anchor.shift_day = d.shift_day
   and adj_anchor.kind = 'start_anchor' and adj_anchor.superseded_by_adjustment_id is null
  left join attendance_adjustments adj_out
    on adj_out.employment_id = d.employment_id and adj_out.shift_day = d.shift_day
   and adj_out.kind = 'early_out_approved' and adj_out.superseded_by_adjustment_id is null
  left join attendance_adjustments adj_half
    on adj_half.employment_id = d.employment_id and adj_half.shift_day = d.shift_day
   and adj_half.kind = 'half_day_override' and adj_half.superseded_by_adjustment_id is null
`;

/** Every day in the range, decided or not — the roster half of T-195 §3.1. */
export async function listDaysForReview(
  tx: Tx,
  input: { orgId: string; storeId: string; from: string; to: string; employmentId?: string },
): Promise<ReviewDayRow[]> {
  const rows = await tx.execute(sql`
    select ${REVIEW_SELECT}
    ${REVIEW_JOINS}
    where d.org_id = ${input.orgId}
      and d.store_id = ${input.storeId}
      and d.shift_day between ${input.from} and ${input.to}
      ${input.employmentId ? sql`and d.employment_id = ${input.employmentId}` : sql``}
    order by d.shift_day desc, p.display_name
  `);
  return camelDays(rows as unknown as Record<string, unknown>[]);
}

/**
 * ⭐ **The queue — the days waiting on a human**, T-195 §3.1.
 *
 * ⛔ Deliberately a superset of "what payroll will not pay": a day with unapproved overtime IS
 * payable and WILL be paid, just not for the overtime — and the overtime vanishing quietly is
 * exactly what DEF-109 was. Being payable is not the same as being settled.
 */
export async function reviewQueue(
  tx: Tx,
  input: { orgId: string; storeId: string; from: string; to: string },
): Promise<QueuedDay[]> {
  const rows = (await tx.execute(sql`
    select ${REVIEW_SELECT}
    ${REVIEW_JOINS}
    where d.org_id = ${input.orgId}
      and d.store_id = ${input.storeId}
      and d.shift_day between ${input.from} and ${input.to}
      and d.frozen_at is null
      and (
        d.status in ('needs_review', 'open')
        or (d.pending_ot_minutes > 0 and adj_ot.approved_ot_minutes is null)
        or (d.computed_minutes <= 0 and adj_ot.approved_ot_minutes is null)
      )
    order by d.shift_day desc, p.display_name
  `)) as unknown as Record<string, unknown>[];

  return camelDays(rows).map((d) => {
    const reasons: ReviewReason[] = [];
    if (d.status === 'needs_review') reasons.push('needs_review');
    if (d.status === 'open') reasons.push('open');
    // ⭐ Held is reported INSTEAD of plain unapproved overtime when the day credits nothing:
    // both are true, but "this day pays nothing at all until you decide" is the sharper fact.
    if (d.computedMinutes <= 0 && d.approvedOtMinutes === null) reasons.push('held_zero_credit');
    else if (d.pendingOtMinutes > 0 && d.approvedOtMinutes === null) {
      reasons.push('unapproved_overtime');
    }
    return { ...d, reasons };
  });
}

/** One day, by id, for the decision surface. */
export async function findDayForReview(
  tx: Tx,
  input: { orgId: string; dayId: string },
): Promise<ReviewDayRow | undefined> {
  const rows = (await tx.execute(sql`
    select ${REVIEW_SELECT}
    ${REVIEW_JOINS}
    where d.org_id = ${input.orgId} and d.id = ${input.dayId}
  `)) as unknown as Record<string, unknown>[];
  return camelDays(rows)[0];
}

/**
 * ⚠️ `d.*` comes back snake_case because it bypasses Drizzle's column mapping. Mapping it here,
 * once, beats three call sites each remembering which half of the row is which.
 */
function camelDays(rows: Record<string, unknown>[]): ReviewDayRow[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k.includes('_') ? k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) : k] = v;
    }
    return out as unknown as ReviewDayRow;
  });
}

/**
 * ⭐ **T-199.** The sweep's one write: a day that will never get its clock-out becomes a day a
 * manager must settle.
 *
 * ⛔ **No punch is fabricated and no end time is invented.** v1 states the rule and it is the half
 * that matters: *"the staffer is clocked out, but the time is not captured. Nobody observed them
 * leaving."* Only the status moves — the evidence is exactly as the staffer left it.
 *
 * ⚠️ The reason is appended to `explain` rather than stored in a new column: `explain` is already
 * the day's narration and the review screen already renders it, so the manager reads *why this is
 * in front of me* in the same place as everything else the engine decided.
 */
export async function markNeedsReview(
  tx: Tx,
  dayId: string,
  why: 'cutoff_hour' | 'max_shift',
): Promise<void> {
  const note =
    why === 'cutoff_hour'
      ? 'Closed by the nightly sweep: still clocked in when the store’s cut-off hour passed. ' +
        'No clock-out time was recorded, because nobody witnessed one.'
      : 'Closed by the sweep: open longer than this store’s maximum shift, so the tap-out was ' +
        'clearly forgotten. No clock-out time was recorded, because nobody witnessed one.';

  await tx.execute(sql`
    update attendance_days
       set status = 'needs_review',
           -- ⚠️ array[...] construction, NOT a bound JS array: passing the array itself makes
           -- Postgres parse the sentence as an array literal and refuse it ("malformed array
           -- literal"). Caught by the test, which is what tests are for.
           -- ⛔ And no backticks in this comment: it lives inside a template literal, so one
           -- would close the string. That mistake was made here once already.
           explain = explain || array[${note}]::text[]
     where id = ${dayId} and frozen_at is null`);
}

/**
 * T-387 S5. How many people are on shift right now: a COUNT of `status = 'open'` days for today's
 * shift day, bound to the stores the caller may see. Never names, never ids.
 *
 * `attendance_days` is an org_column table, so RLS isolates ORGS; the store boundary is the
 * `storeIds` argument (the dashboard passes the stores `reportScope` allowed). An empty list is 0,
 * never "all stores".
 */
export async function countOpenToday(
  tx: Tx,
  orgId: string,
  storeIds: readonly string[],
): Promise<number> {
  if (storeIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: count() })
    .from(attendanceDays)
    .where(
      and(
        eq(attendanceDays.orgId, orgId),
        inArray(attendanceDays.storeId, [...storeIds]),
        eq(attendanceDays.status, 'open'),
        eq(attendanceDays.shiftDay, toBusinessDate()),
      ),
    );
  return Number(row?.n ?? 0);
}
