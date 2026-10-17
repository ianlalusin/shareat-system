/**
 * `adjudicateDay` — the thin transactional shell around `computeDay`. T-157.
 * `docs/tasks/157-attendance-adjudication.md` §7.
 *
 * ## ⛔ One resolver, and every caller goes through it
 *
 * The ingestor (T-182), the manager screen (T-158), the payroll preview (Phase 5) and the roster
 * (T-166) all call this. **Nothing else recomputes.** v1 learned this the expensive way: three
 * hand-maintained copies of the arithmetic drifted, and *"a review edit silently dropped short-shift
 * OT, so correcting a short shift cut the staffer's pay by the remainder the clock terminal would
 * have raised."*
 *
 * ⭐ The arithmetic itself is in `compute-day.ts` and is **pure** — values in, values out, no
 * database and no clock. That is what makes it property-testable and golden-masterable at all, and
 * it is the same shape `packages/domain/src/ledger/` already uses.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  attendanceAdjustmentsRepo,
  attendanceDaysRepo,
  attendancePunchesRepo,
  employmentRepo,
  type AttendanceConfigRow,
  type AttendanceDayRow,
  type AttendancePunchRow,
  type Tx,
} from '@shareat/db';
import type { AttendanceDayStatus } from '@shareat/db/schema';
import { getConfigForShiftDay } from './config';
import { computeDay, type DayAdjustments, type DayPolicy, type DayPunch } from './compute-day';
import { parseShiftDay, type ShiftDay } from './shift-day';
// T-436: leaf module (db repos + audit only), so attendance can import it without a cycle through payroll.
import { reconcileLeaveWithWorkedDay } from '../leave/worked';

export class AdjudicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjudicationError';
  }
}

/** The anomalies that mean a day cannot be trusted for pay until a human settles it. */
const BLOCKING_ANOMALIES = new Set([
  'missing_in',
  'missing_out',
  'no_punches',
  'overlapping',
  'break_not_closed',
  'inverted_window',
  'late_event_arrival',
  // DEF-088 — credited far more than the time present. Never auto-payable.
  'implausible_span',
]);

/**
 * ⚠️ **Not every anomaly blocks, and the screen must say which.**
 *
 * `start_not_allowed` is advisory by design — on Lipa's stale grid it fires on a large share of
 * sessions, and blocking there would hold a store's pay for a data-entry problem (DEF-087). T-225's
 * `half_day_near_full` is advisory for the same reason: it asks a question, it does not assert the
 * day is untrustworthy.
 *
 * ⛔ Exported because `/attendance/[dayId]` told the manager *"a day with an unresolved anomaly
 * cannot be verified"*, which was **already untrue** for `start_not_allowed` before this existed —
 * prose claiming something the code does not do, the shape this project has filed nine defects
 * about. The screen now asks rather than restates.
 */
export function isBlockingAnomaly(anomaly: string): boolean {
  return BLOCKING_ANOMALIES.has(anomaly);
}

/** Translate a stored config row into the pure function's policy. */
export function policyFromConfig(config: AttendanceConfigRow): DayPolicy {
  const toMinutes = (hours: string) => Math.round(Number(hours) * 60);
  return {
    requiredMinutes: toMinutes(config.requiredHoursPerShift),
    halfDayMinutes: toMinutes(config.halfDayHours),
    shortShiftHalfDayOt: config.shortShiftHalfDayOt,
    halfDayOnMissingTap: config.halfDayOnMissingTap,
    allowedShiftStartHours: config.allowedShiftStartHours,
    lateGraceMinutes: config.lateGraceMinutes,
    earlyOutGraceMinutes: config.earlyOutGraceMinutes,
    undertimeGraceMinutes: config.undertimeGraceMinutes,
    nightDiffEnabled: config.nightDiffEnabled,
    nightDiffStartHour: config.nightDiffStartHour,
    nightDiffEndHour: config.nightDiffEndHour,
    allowableBreakMinutes: toMinutes(config.defaultBreakHours),
    anchorWindowMinutes: config.anchorWindowMinutes,
  };
}

const toDayPunch = (p: AttendancePunchRow): DayPunch => ({
  occurredAt: p.occurredAt,
  intent: p.assertedIntent,
  arrivalLagMs: p.receivedAt.getTime() - p.occurredAt.getTime(),
});

export interface AdjudicateInput {
  employmentId: string;
  shiftDay: ShiftDay;
  /** The manager's decisions (T-158). Passed in so the engine stays pure. */
  adjustments?: DayAdjustments;
  isHoliday?: boolean;
  holidayType?: 'regular' | 'special_non_working' | 'special_working' | null;
}

/**
 * Recompute one person-day from its punches, its config and its adjustments.
 *
 * ⛔ Refuses on a frozen day. The trigger refuses too — this is the comprehensible half of the
 * same rule (bible §16.4: the database enforces, the service explains).
 */
export async function adjudicateDay(tx: Tx, input: AdjudicateInput): Promise<AttendanceDayRow> {
  const employment = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!employment) throw new AdjudicationError(`No employment ${input.employmentId}`);

  const existing = await attendanceDaysRepo.findDay(tx, {
    employmentId: input.employmentId,
    shiftDay: input.shiftDay,
  });
  if (existing?.frozenAt) {
    throw new AdjudicationError(
      `Attendance day ${existing.id} (${input.shiftDay}) is frozen by pay run ${existing.frozenByPayRunId}. ` +
        'Recomputing it would restate what was already paid — correct it through payroll instead.',
    );
  }

  const config = await getConfigForShiftDay(tx, { storeId: employment.storeId, day: input.shiftDay });
  const punches = await attendancePunchesRepo.listForDay(tx, {
    employmentId: input.employmentId,
    shiftDay: input.shiftDay,
  });

  // ⛔ **A recompute LOADS the live decisions rather than trusting the caller to pass them.**
  //
  // They used to be a parameter that only `recordAdjustment` ever filled, because it had just
  // written one. Every other caller passed nothing — including `adjudicateRange`, the sweep — so a
  // recompute silently dropped every standing decision on the day. With DEF-115's fix driving the
  // day's STATUS from those decisions, that would have let a sweep **un-void a day a manager had
  // discarded, and payroll would pay it again**.
  //
  // ⚠️ The parameter stays only as an explicit override for a caller that has already computed
  // them inside the same transaction; `??` means forgetting it is now harmless rather than
  // destructive. A default of `{}` was the footgun.
  const adjustments =
    input.adjustments ?? (await toDayAdjustments(tx, input.employmentId, input.shiftDay));

  const result = computeDay({
    shiftDay: input.shiftDay,
    punches: punches.map(toDayPunch),
    policy: policyFromConfig(config),
    adjustments,
  });

  const ins = punches.filter((p) => p.assertedIntent === 'in');
  const outs = punches.filter((p) => p.assertedIntent === 'out');

  const isHoliday = input.isHoliday ?? false;

  const day = await attendanceDaysRepo.upsertDay(tx, {
    orgId: employment.orgId,
    storeId: employment.storeId,
    personId: employment.personId,
    employmentId: employment.id,
    shiftDay: input.shiftDay,
    attendanceConfigId: config.id,
    firstInPunchId: ins[0]?.id ?? null,
    lastOutPunchId: outs[outs.length - 1]?.id ?? null,
    anchorMinute: result.anchorMinute,
    anchorMode: result.anchorMode,
    endMinute: result.endMinute,
    computedMinutes: result.computedMinutes,
    isHalfDay: result.isHalfDay,
    cappedAtRequired: result.cappedAtRequired,
    lateMinutes: result.lateMinutes,
    lateChargeableMinutes: result.lateChargeableMinutes,
    earlyOutMinutes: result.earlyOutMinutes,
    undertimeForgivenMinutes: result.undertimeForgivenMinutes,
    breakMinutes: result.breakMinutes,
    allowableBreakMinutes: result.allowableBreakMinutes,
    breakOverMinutes: result.breakOverMinutes,
    nightDiffMinutes: result.nightDiffMinutes,
    isHoliday,
    holidayType: isHoliday ? (input.holidayType ?? 'regular') : null,
    holidayMinutes: isHoliday ? result.computedMinutes : 0,
    pendingOtMinutes: result.pendingOtMinutes,
    status: resolveStatus(result.anomalies, punches, existing?.status, adjustments.managerDecision),
    anomalies: result.anomalies,
    explain: result.explain,
    computedFromPunchCount: punches.length,
  });

  // ⭐ T-436 (spec D8): punches on a date with approved leave. Unpaid leave is superseded by the work; leave already paid in a run
  // holds THIS day from payroll (needs_review + clash) so the date is never paid twice. Returns the row as it now stands.
  const outcome = await reconcileLeaveWithWorkedDay(tx, {
    orgId: day.orgId,
    personId: day.personId,
    shiftDay: day.shiftDay,
    attendanceStatus: day.status,
  });
  return outcome === 'held' ? { ...day, status: 'needs_review' } : day;
}

/**
 * ⛔ **A recompute never promotes a `needs_review` day to payable.**
 *
 * v1 states the rule and the reason: *"if the session being closed was already `needs_review` (e.g.
 * manager-flagged missing-out), a replay's clock-out data is written but the status is deliberately
 * kept at `needs_review` rather than promoted"* — because the promoted status is in payroll's
 * `PAYABLE_STATUSES` (`attendance-clock.actions.ts:309-314`). A late-arriving offline punch must not
 * silently make a flagged day payable.
 *
 * `verified` and `voided` are a manager's decisions and outrank a recompute in the same way.
 */
function resolveStatus(
  anomalies: readonly string[],
  punches: readonly AttendancePunchRow[],
  previous: AttendanceDayStatus | undefined,
  managerDecision: 'verified' | 'voided' | undefined,
): AttendanceDayStatus {
  // ⛔ **DEF-115 — the manager's live decision decides, and it OUTRANKS everything below.**
  //
  // This used to read `if (previous === 'voided' || previous === 'verified') return previous`,
  // which preserved those statuses but could never PRODUCE one — nothing anywhere wrote them. So
  // T-158's §7 promise (*"a voided day contributes nothing to payroll"*) was never kept: a voided
  // day stayed `computed` and `payableDays` paid it in full.
  //
  // ⭐ Driving it from the live adjustment is also strictly better than the sticky `previous`:
  // superseding or removing the decision now lets the day fall back to its computed status,
  // instead of a status that could never be undone once set.
  if (managerDecision) return managerDecision;
  if (previous === 'needs_review') return 'needs_review';

  if (anomalies.some((a) => BLOCKING_ANOMALIES.has(a))) {
    // An in with no out yet, and nothing else wrong, is a shift still running rather than a problem.
    const onlyMissingOut = anomalies.length === 1 && anomalies[0] === 'missing_out';
    if (onlyMissingOut && punches.some((p) => p.assertedIntent === 'in')) return 'open';
    return 'needs_review';
  }
  return 'computed';
}

/** Recompute every person-day in a store over a range. Used by the review screen and the sweep. */
export async function adjudicateRange(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; from: string; to: string },
): Promise<AttendanceDayRow[]> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });

  const punches = await attendancePunchesRepo.listForStoreRange(tx, input);
  const seen = new Set<string>();
  const out: AttendanceDayRow[] = [];
  for (const p of punches) {
    const key = `${p.employmentId}:${p.shiftDay}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      await adjudicateDay(tx, { employmentId: p.employmentId, shiftDay: parseShiftDay(p.shiftDay) }),
    );
  }
  return out;
}

/** The live decisions, shaped for the computation. */
export async function toDayAdjustments(
  tx: Tx,
  employmentId: string,
  shiftDay: ShiftDay,
): Promise<DayAdjustments> {
  const live = await attendanceAdjustmentsRepo.listLive(tx, { employmentId, shiftDay });
  const out: DayAdjustments = {};
  for (const a of live) {
    if (a.kind === 'start_anchor' && a.chosenAnchorMinute !== null) {
      out.startAnchorMinute = a.chosenAnchorMinute;
    }
    if (a.kind === 'early_out_approved' && a.effectiveOutMinute !== null) {
      out.earlyOutApprovedToMinute = a.effectiveOutMinute;
    }
    if (a.kind === 'half_day_override' && a.isHalfDay !== null) {
      out.halfDayOverride = a.isHalfDay === 'true';
    }
    // ⛔ DEF-115. A void OUTRANKS a verify: the two cannot both stand as live decisions today,
    // but if that ever changes, "discard this day" is the safer of the two to honour.
    if (a.kind === 'void') out.managerDecision = 'voided';
    else if (a.kind === 'verify' && out.managerDecision !== 'voided') {
      out.managerDecision = 'verified';
    }
  }
  return out;
}
