/**
 * Manager adjustments — decisions as attributed inputs. T-158.
 * `docs/tasks/158-attendance-adjustments.md`.
 */
import { sql } from 'drizzle-orm';
import { authorize, type Actor } from '@shareat/auth';
import {
  attendanceAdjustmentsRepo,
  attendanceDaysRepo,
  employmentRepo,
  type AttendanceAdjustmentRow,
  type AttendanceDayRow,
  type Tx,
} from '@shareat/db';
import type { AdjustmentKind } from '@shareat/db/schema';
import { adjudicateDay } from './adjudicate';
import { type DayAdjustments, type DayPolicy } from './compute-day';
import { shiftDayOffsetMsForHour, type ShiftDay } from './shift-day';

export class AdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjustmentError';
  }
}

export interface RecordAdjustmentInput {
  employmentId: string;
  shiftDay: ShiftDay;
  kind: AdjustmentKind;
  chosenAnchorMinute?: number;
  effectiveOutMinute?: number;
  isHalfDay?: boolean;
  reason?: string;
  /** The verified session the decision was made under. From `resolveActor` (§7.1). */
  sessionId: string;
}

/**
 * Record one decision, superseding any live decision of the same kind, and **re-adjudicate the day
 * in the same transaction** — so the day and its decisions can never be seen disagreeing.
 */
export async function recordAdjustment(
  tx: Tx,
  actor: Actor,
  input: RecordAdjustmentInput,
): Promise<{ adjustment: AttendanceAdjustmentRow; day: AttendanceDayRow }> {
  const employment = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!employment) throw new AdjustmentError(`No employment ${input.employmentId}`);

  await authorize(tx, actor, 'manage_attendance', {
    storeId: employment.storeId,
    orgId: employment.orgId,
  });

  // ⛔ Self-adjudication. Bible §7 rule 6: *"no one approves, pays, adjusts, or scores their own
  // record. Admins may be exempted, explicitly and auditably."* The exemption is explicit here and
  // the adjustment row itself is the audit — it names who decided.
  if (employment.personId === actor.personId) {
    const isAdmin = await actorIsAdmin(tx, actor);
    if (!isAdmin) {
      throw new AdjustmentError(
        'You cannot adjudicate your own attendance. An admin can, and the decision is recorded ' +
          'against their name.',
      );
    }
  }

  const existingDay = await attendanceDaysRepo.findDay(tx, {
    employmentId: input.employmentId,
    shiftDay: input.shiftDay,
  });
  if (existingDay?.frozenAt) {
    throw new AdjustmentError(
      `Attendance day ${existingDay.id} is frozen by pay run ${existingDay.frozenByPayRunId}. ` +
        'Adjusting it would restate what was already paid — go through payroll instead.',
    );
  }

  if (input.kind === 'verify') {
    // ⚠️ A day with an unaddressed anomaly cannot be verified. Otherwise "verified" means only that
    // somebody clicked, which is worse than no sign-off at all because it looks like one.
    if (existingDay && existingDay.anomalies.length > 0) {
      throw new AdjustmentError(
        `This day still has unresolved anomalies (${existingDay.anomalies.join(', ')}). Settle them ` +
          'first — a verification that ignores them records a sign-off nobody actually made.',
      );
    }
  }

  const live = await attendanceAdjustmentsRepo.listLive(tx, {
    employmentId: input.employmentId,
    shiftDay: input.shiftDay,
  });

  assertNotInverted({ live, incoming: input });

  const superseded = live.find((a) => a.kind === input.kind);

  // ⚠️ Mint the new id, retire the old decision, THEN insert. `attendance_adjustments_live_unique`
  // is a plain partial unique index, so two live decisions of one kind are illegal even for a
  // single statement — and the old row's `superseded_by` needs the new id, which is why the id is
  // minted rather than left to the column default. Same shape as the config supersede.
  const id = await attendanceAdjustmentsRepo.nextAdjustmentId(tx);
  if (superseded) {
    await attendanceAdjustmentsRepo.markSuperseded(tx, superseded.id, id);
  }

  const adjustment = await attendanceAdjustmentsRepo.insertAdjustment(tx, {
    id,
    orgId: employment.orgId,
    storeId: employment.storeId,
    employmentId: employment.id,
    shiftDay: input.shiftDay,
    kind: input.kind,
    chosenAnchorMinute: input.chosenAnchorMinute ?? null,
    effectiveOutMinute: input.effectiveOutMinute ?? null,
    isHalfDay: input.isHalfDay === undefined ? null : String(input.isHalfDay),
    reason: input.reason ?? null,
    decidedBySessionId: input.sessionId,
    decidedByPersonId: actor.personId,
  });

  const day = await adjudicateDay(tx, {
    employmentId: input.employmentId,
    shiftDay: input.shiftDay,
    adjustments: await toDayAdjustments(tx, input.employmentId, input.shiftDay),
  });

  return { adjustment, day };
}

/** Every decision ever made about a day — the audit answer, superseded rows included. */
export async function listAdjustments(
  tx: Tx,
  input: { employmentId: string; shiftDay: ShiftDay },
): Promise<AttendanceAdjustmentRow[]> {
  return attendanceAdjustmentsRepo.listAll(tx, input);
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
  }
  return out;
}

/**
 * ⛔ **C1 — the inverted-window guard**, enforced where the combination is FORMED.
 *
 * v1 `workday.ts:126-165`: a Late/Next-in decision plus an early-out approval can produce a paid
 * window *"whose end is before its start"*, which *"would let the pairer silently swap in/out and
 * fabricate a fictitious shift."*
 *
 * ⭐ Refused at creation, with both conflicting decisions named — and T-157's engine ALSO clamps and
 * raises an anomaly if one ever arrives another way. Two layers, because they fail differently:
 * this one gives a manager a comprehensible refusal, that one survives a path nobody anticipated
 * (bible §15.11).
 */
function assertNotInverted(params: {
  live: readonly AttendanceAdjustmentRow[];
  incoming: RecordAdjustmentInput;
}): void {
  const { live, incoming } = params;

  const anchorMinute =
    incoming.kind === 'start_anchor'
      ? incoming.chosenAnchorMinute
      : live.find((a) => a.kind === 'start_anchor')?.chosenAnchorMinute ?? undefined;

  const outMinute =
    incoming.kind === 'early_out_approved'
      ? incoming.effectiveOutMinute
      : live.find((a) => a.kind === 'early_out_approved')?.effectiveOutMinute ?? undefined;

  if (anchorMinute === undefined || outMinute === undefined || outMinute === null || anchorMinute === null) {
    return;
  }

  if (outMinute <= anchorMinute) {
    throw new AdjustmentError(
      `These two decisions cannot both hold: the day would be paid from minute ${anchorMinute} to ` +
        `minute ${outMinute}, which ends at or before it starts. The start anchor and the early-out ` +
        'approval disagree — change one of them.',
    );
  }
}

/**
 * ⭐ **Is this decision even worth asking a manager for?**
 *
 * `isStartDecisionMaterial` exists in v1 (`shift-boundaries.ts:492-507`) because, **measured at one
 * branch, 52% of all flagged sessions were already full shifts regardless of which start they were
 * anchored to.** Asking anyway produced a wall of meaningless prompts.
 *
 * True only when the two candidate anchors produce different paid minutes, a different half-day
 * verdict, or different late minutes under a policy that charges for them.
 *
 * ⚠️ Kept as a named, tested function rather than a filter inlined into a screen — a rule buried in
 * a query is a rule the next screen forgets. It is an operational-load finding, not a technical one,
 * and it survives even though the computation around it changed.
 */
export function isStartDecisionMaterial(params: {
  day: Pick<AttendanceDayRow, 'anchorMinute' | 'endMinute'>;
  policy: DayPolicy;
  lateCostsMoney: boolean;
}): boolean {
  const { day, policy, lateCostsMoney } = params;
  if (day.anchorMinute === null || day.endMinute === null) return false;

  const offsets = policy.allowedShiftStartHours
    .map((h) => shiftDayOffsetMsForHour(h) / 60_000)
    .sort((a, b) => a - b);

  const next = offsets.find((o) => o > day.anchorMinute!);
  if (next === undefined) return false;

  const paidFrom = (anchorMinute: number) => {
    const raw = Math.max(0, day.endMinute! - anchorMinute);
    const capped = Math.min(raw, policy.requiredMinutes);
    if (policy.shortShiftHalfDayOt && capped < policy.requiredMinutes && capped >= policy.halfDayMinutes) {
      return { minutes: policy.halfDayMinutes, halfDay: true };
    }
    return { minutes: capped, halfDay: false };
  };

  const here = paidFrom(day.anchorMinute);
  const there = paidFrom(next);

  if (here.minutes !== there.minutes) return true;
  if (here.halfDay !== there.halfDay) return true;
  // Lateness only matters to a manager when it actually costs the staffer something.
  return lateCostsMoney && day.anchorMinute !== next;
}

/** Whether the actor holds the org-wide admin role — the only self-adjudication exemption. */
async function actorIsAdmin(tx: Tx, actor: Actor): Promise<boolean> {
  const result = await tx.execute<{ present: boolean }>(sql`
    select exists (
      select 1 from person_roles
      where person_id = ${actor.personId} and org_id = ${actor.orgId}
        and role in ('admin', 'super_admin') and revoked_at is null
    ) as present`);
  return Boolean((result as unknown as { present: boolean }[])[0]?.present);
}
