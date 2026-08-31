/**
 * T-195 — the read side of the attendance day review screen. **DEF-113.**
 *
 * ⛔ Until this task, `recordAdjustment` had **no caller outside tests**. Six adjustment kinds
 * shipped in T-158, fully tested, and no screen invoked any of them — so overtime could never be
 * approved, a `needs_review` day could never be resolved (and `payableDays` excludes it, so
 * nothing would ever pay it), and no day could be verified. `/payroll` told managers to *"approve
 * it on the attendance day"* and there was no attendance day to open.
 *
 * ⭐ The screen was promised four times as **"T-166"** by T-154, T-156, T-157 and T-158. The
 * inventory lane shipped T-166 as *Deliveries and receiving*. It was overwritten, not descoped.
 *
 * **Read-only.** Every decision goes through `recordAdjustment` (T-158), unchanged.
 */
import { attendanceDaysRepo, attendancePunchesRepo, type Tx } from '@shareat/db';
import type { QueuedDay, ReviewDayRow, ReviewReason } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import type { AttendancePunchRow } from '@shareat/db';

export type { QueuedDay, ReviewDayRow, ReviewReason };

/**
 * ⭐ Why the day is in the queue, in words a manager can act on.
 *
 * ⚠️ Kept here rather than in the component: the reason a day needs attention is a domain fact,
 * and a second copy inlined into JSX is a rule the next screen forgets (T-158).
 */
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  needs_review:
    'Flagged for review — payroll excludes it, and a recompute will NOT clear it. Until someone ' +
    'verifies or voids this day, nothing will ever pay it.',
  open: 'Clocked in with no clock-out — either a shift still running, or a missed tap.',
  unapproved_overtime:
    'Overtime was recorded and nobody has decided it. It is not paid until you do.',
  held_zero_credit:
    'Too short to credit a day at all, so the whole stint is waiting as overtime. ' +
    'The pay run HOLDS this day — it is not paid and not frozen — until you decide.',
};

export interface DayReviewDetail {
  day: ReviewDayRow;
  punches: AttendancePunchRow[];
  /** ⛔ True when a pay run has already paid this day. Every decision must refuse. */
  frozen: boolean;
  /**
   * ⚠️ Why the decision controls are closed, or null when they are open. Returned as a REASON
   * rather than a boolean so the screen can say why instead of silently disabling a button —
   * the failure mode DEF-113's own root cause (an invisible gap) is made of.
   */
  lockedReason: string | null;
}

/** The days waiting on a human. T-195 §3.1. */
export async function attendanceReviewQueue(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; from: string; to: string },
): Promise<QueuedDay[]> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });
  return attendanceDaysRepo.reviewQueue(tx, { orgId: actor.orgId, ...input });
}

/** Every day in the range, decided or not — the roster half. */
export async function attendanceRoster(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; from: string; to: string; employmentId?: string },
): Promise<ReviewDayRow[]> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });
  return attendanceDaysRepo.listDaysForReview(tx, { orgId: actor.orgId, ...input });
}

/**
 * One day, with the evidence behind it.
 *
 * ⭐ The punches are returned so the screen can render them **read-only**. v1 states the principle
 * and v2's whole adjustment table rests on it: *"The original clock-in is never changed. It is a
 * label."* A correction is a decision recorded beside the fact, never a rewrite of the fact.
 */
export async function attendanceDayDetail(
  tx: Tx,
  actor: Actor,
  dayId: string,
): Promise<DayReviewDetail | undefined> {
  const day = await attendanceDaysRepo.findDayForReview(tx, { orgId: actor.orgId, dayId });
  if (!day) return undefined;
  await authorize(tx, actor, 'manage_attendance', { storeId: day.storeId });

  const punches = await attendancePunchesRepo.listForDay(tx, {
    employmentId: day.employmentId,
    shiftDay: day.shiftDay,
  });

  // ⛔ Bible §7 rule 6, mirrored for DISPLAY only. `recordAdjustment` already refuses this and
  // remains the enforcement point — this exists so the screen can explain a closed control
  // rather than fail on submit. Never the other way round.
  const isOwnDay = day.personId === actor.personId;

  const lockedReason = day.frozenAt
    ? 'A pay run has already paid this day, so it is frozen. A correction goes through payroll — ' +
      'void the run — not by restating the day.'
    : isOwnDay
      ? 'This is your own attendance day. Nobody adjudicates their own record.'
      : null;

  return { day, punches, frozen: day.frozenAt !== null, lockedReason };
}
