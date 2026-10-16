/**
 * Server-only helpers for `/attendance`. T-195, closing **DEF-113**.
 *
 * ⛔ Until this screen existed, `recordAdjustment` had **no caller outside tests** — six adjustment
 * kinds, fully built and tested, unreachable from the running app. Overtime could never be
 * approved, a `needs_review` day could never be resolved (and nothing else can resolve one, so it
 * would never be paid by anything), and no day could be verified or voided.
 */
import {
  leaveGrid,
  type LeaveRow,
  attendanceDayDetail,
  attendanceReviewQueue,
  attendanceRoster,
  derivePeriods,
  type DayReviewDetail,
  type QueuedDay,
  type ReviewDayRow,
} from '@shareat/domain';
import { attendanceConfigRepo } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { withOrgPrincipal } from '../expenses/lib';

export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';
export { REVIEW_REASON_TEXT } from '@shareat/domain';
export type { DayReviewDetail, QueuedDay, ReviewDayRow };

type Actor = { orgId: string; personId: string };

export async function loadQueue(
  orgId: string,
  actor: Actor,
  input: { storeId: string; from: string; to: string },
): Promise<QueuedDay[]> {
  return withOrgPrincipal(orgId, (tx) => attendanceReviewQueue(tx, actor, input));
}

export async function loadRoster(
  orgId: string,
  actor: Actor,
  input: { storeId: string; from: string; to: string },
): Promise<ReviewDayRow[]> {
  return withOrgPrincipal(orgId, (tx) => attendanceRoster(tx, actor, input));
}

/**
 * T-436: pending and approved leave in the period, with Paid / Unpaid per date and a clash flag where punches exist.
 * The kind only - never a note and never a certificate. A viewer without `manage_attendance` here gets an empty grid,
 * not an error: the review screen is already gated by what it reads first.
 */
export async function loadLeaveGrid(
  orgId: string,
  actor: Actor,
  input: { storeId: string; from: string; to: string },
): Promise<LeaveRow[]> {
  try {
    return await withOrgPrincipal(orgId, (tx) => leaveGrid(tx, actor, input));
  } catch (err) {
    if (err instanceof AuthorizationError) return [];
    throw err;
  }
}

export async function loadDay(
  orgId: string,
  actor: Actor,
  dayId: string,
): Promise<DayReviewDetail | undefined> {
  return withOrgPrincipal(orgId, (tx) => attendanceDayDetail(tx, actor, dayId));
}

/**
 * ⭐ The default range is the **current payroll period**, not "this month".
 *
 * That is the question a manager actually has: everything in the period about to be paid must be
 * settled before it is. A calendar month would straddle two runs and hide the deadline.
 */
export async function defaultRange(
  orgId: string,
  storeId: string,
  today: string,
): Promise<{ from: string; to: string }> {
  const config = await withOrgPrincipal(orgId, (tx) => attendanceConfigRepo.findLive(tx, storeId));
  if (!config) return { from: today, to: today };
  const [y, m] = today.split('-').map(Number) as [number, number];
  const periods = derivePeriods(config, y, m);
  const current = periods.find((p) => p.start <= today && today <= p.end) ?? periods[0];
  return current ? { from: current.start, to: current.end } : { from: today, to: today };
}

/** Minutes-from-shift-start rendered as a clock time a human reads. */
export function asClock(minute: number | null): string {
  if (minute === null) return '—';
  const total = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function asHours(minutes: number): string {
  if (minutes === 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : h === 0 ? `${m}m` : `${h}h ${m}m`;
}
