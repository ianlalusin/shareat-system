/**
 * Manager adjustments — decisions as attributed inputs. T-158.
 * `docs/tasks/158-attendance-adjustments.md`.
 */
import { sql } from 'drizzle-orm';
import { logger } from '@shareat/core/logger';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import {
  attendanceAdjustmentsRepo,
  attendanceDaysRepo,
  employmentRepo,
  type AttendanceAdjustmentRow,
  type AttendanceDayRow,
  type Tx,
} from '@shareat/db';
import type { AdjustmentKind } from '@shareat/db/schema';
import { refuse } from '../shared/refusal';
import { parseWholeNumberInput } from '../shared/whole-number-input';
import { assertFieldRules } from '../shared/field-rules-assert';
import { ATTENDANCE_EARLY_OUT_RULES, ATTENDANCE_OVERTIME_RULES, ATTENDANCE_START_ANCHOR_RULES } from '../field-rules/attendance';
import { adjudicateDay } from './adjudicate';
import { type DayAdjustments, type DayPolicy } from './compute-day';
import { parseShiftDay, shiftDayOffsetMsForHour, type RawShiftDay, type ShiftDay } from './shift-day';

export class AdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjustmentError';
  }
}

export interface RecordAdjustmentInput {
  employmentId: string;
  shiftDay: ShiftDay | RawShiftDay;
  kind: AdjustmentKind;
  chosenAnchorMinute?: number | string;
  effectiveOutMinute?: number | string;
  isHalfDay?: boolean;
  /** ⭐ `overtime_approved` only — how many of the day's PENDING minutes are accepted. */
  approvedOtMinutes?: number | string;
  reason?: string;
  /** The verified session the decision was made under. From `resolveActor` (§7.1). */
  sessionId: string;
}

/** `RecordAdjustmentInput` with its three minute fields parsed to `number` — T-352 / DEF-478. */
type ParsedAdjustmentInput = Omit<
  RecordAdjustmentInput,
  'chosenAnchorMinute' | 'effectiveOutMinute' | 'approvedOtMinutes'
> & {
  chosenAnchorMinute?: number;
  effectiveOutMinute?: number;
  approvedOtMinutes?: number;
};

const MINUTE_LABELS: Record<'chosenAnchorMinute' | 'effectiveOutMinute' | 'approvedOtMinutes', string> = {
  approvedOtMinutes: 'The minutes to pay',
  chosenAnchorMinute: 'The paid-from minute',
  effectiveOutMinute: 'The paid-until minute',
};

/**
 * T-352 / DEF-478 — moved from the action's `wholeMinutes()`. Blank keeps DEF-471's own sentence
 * (Ian: a blank minutes box means "not decided", not 0), which `parseWholeNumberInput`'s blank
 * wording does not match; a non-blank value defers to it for the whole-number/range check.
 */
function parseMinutes(raw: string | number, key: string, label: string): number {
  const t = String(raw).trim();
  if (t === '') {
    throw refuse(`recordAdjustment: ${key} is blank`, `${label} — enter a whole number of minutes (0 to 99999).`);
  }
  return parseWholeNumberInput(t, `recordAdjustment: ${key}`, label, 0, 99999, ' of minutes');
}

/**
 * T-364 / DEF-497 (R6) — the ONE sentence an unauthorised caller gets for an employment id, whether
 * the id exists and is out of reach or does not exist at all. Two sentences would be an oracle.
 */
const EMPLOYMENT_OUT_OF_REACH =
  'That employment does not exist, or it is not at a store where you manage attendance.';

const SHIFT_DAY_MISSING = 'The shift day is missing. Reopen the day from the attendance list and try again.';
const shiftDayMalformed = (v: string) =>
  `The shift day — "${v}" is not a date. Reopen the day from the attendance list and try again.`;

/**
 * T-360 / DEF-488 — parses `RecordAdjustmentInput.shiftDay` so a malformed value gets a sentence
 * instead of reaching Postgres as `'abc'::date`. Impossible calendar dates (`2026-02-30`) are refused
 * by `parseShiftDay` itself (T-370 S2 / DEF-494: `parseBusinessDate` checks the month length).
 */
function parseShiftDayInput(raw: string): ShiftDay {
  const t = String(raw).trim();
  if (t === '') {
    throw refuse('recordAdjustment: shiftDay is blank', SHIFT_DAY_MISSING);
  }
  let day: ShiftDay;
  try {
    day = parseShiftDay(t);
  } catch {
    throw refuse(`recordAdjustment: shiftDay ${JSON.stringify(t)} is not a YYYY-MM-DD shift day`, shiftDayMalformed(t));
  }
  return day;
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
  // T-364 / DEF-497 — the lookup stays first because it supplies the gate's store, but a missing
  // row, another org's row and a row the caller may not manage all surface as ONE refusal
  // (AuthorizationError, same userMessage), so the reply cannot be used to probe ids or learn a
  // person's store. The real diagnosis goes to the server log (never the screen) and rides on `cause`.
  const employment = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!employment || employment.orgId !== actor.orgId) {
    const raw = `recordAdjustment: no employment ${input.employmentId} in org ${actor.orgId}`;
    logger.warn({ employmentId: input.employmentId, actorOrgId: actor.orgId }, raw);
    throw new AuthorizationError(raw, 'manage_attendance', EMPLOYMENT_OUT_OF_REACH);
  }
  try {
    await authorize(tx, actor, 'manage_attendance', {
      storeId: employment.storeId,
      orgId: employment.orgId,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      logger.warn({ employmentId: input.employmentId, err }, `recordAdjustment: ${err.message}`);
      const uniform = new AuthorizationError(`recordAdjustment: ${err.message}`, 'manage_attendance', EMPLOYMENT_OUT_OF_REACH);
      uniform.cause = err;
      throw uniform;
    }
    throw err;
  }

  // T-352 / DEF-478 — parsed directly after `authorize()`, so a non-holder sees the authorization
  // refusal rather than a field sentence for a form they were never allowed to submit.
  const parsed: ParsedAdjustmentInput = {
    ...input,
    chosenAnchorMinute:
      input.chosenAnchorMinute === undefined
        ? undefined
        : parseMinutes(input.chosenAnchorMinute, 'chosenAnchorMinute', MINUTE_LABELS.chosenAnchorMinute),
    effectiveOutMinute:
      input.effectiveOutMinute === undefined
        ? undefined
        : parseMinutes(input.effectiveOutMinute, 'effectiveOutMinute', MINUTE_LABELS.effectiveOutMinute),
    approvedOtMinutes:
      input.approvedOtMinutes === undefined
        ? undefined
        : parseMinutes(input.approvedOtMinutes, 'approvedOtMinutes', MINUTE_LABELS.approvedOtMinutes),
  };

  // T-440: the minute boxes' rule sets (the very ones the screen checks live) are asserted here, AFTER authorize() and
  // after the pinned sentences above, so a non-holder still sees only the authorization refusal (T-352) and nobody sees a
  // new sentence for a value `parseMinutes` already accepted. Whenever parseMinutes passed, these pass.
  if (parsed.chosenAnchorMinute !== undefined) assertFieldRules(ATTENDANCE_START_ANCHOR_RULES, { chosenAnchorMinute: String(parsed.chosenAnchorMinute) });
  if (parsed.effectiveOutMinute !== undefined) assertFieldRules(ATTENDANCE_EARLY_OUT_RULES, { effectiveOutMinute: String(parsed.effectiveOutMinute) });
  if (parsed.approvedOtMinutes !== undefined) assertFieldRules(ATTENDANCE_OVERTIME_RULES, { approvedOtMinutes: String(parsed.approvedOtMinutes) });

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

  // T-360 / DEF-488 — parsed after `authorize()` and the self-adjudication check (R3): a non-holder
  // still sees the authorization refusal, and a manager adjudicating their own day still sees that
  // refusal, for a malformed shiftDay exactly as for a valid one. Only from here on does the parsed
  // local replace `input.shiftDay`.
  const shiftDay = parseShiftDayInput(input.shiftDay);

  const existingDay = await attendanceDaysRepo.findDay(tx, {
    employmentId: input.employmentId,
    shiftDay,
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
    shiftDay,
  });

  assertNotInverted({ live, incoming: parsed });

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
    shiftDay,
    kind: input.kind,
    chosenAnchorMinute: parsed.chosenAnchorMinute ?? null,
    effectiveOutMinute: parsed.effectiveOutMinute ?? null,
    isHalfDay: input.isHalfDay === undefined ? null : String(input.isHalfDay),
    approvedOtMinutes: parsed.approvedOtMinutes ?? null,
    reason: input.reason ?? null,
    decidedBySessionId: input.sessionId,
    decidedByPersonId: actor.personId,
  });

  // ⚠️ No `adjustments` argument: `adjudicateDay` loads the live decisions itself, including the
  // one just inserted above (same transaction). Passing them here as well was the last remaining
  // caller of a parameter whose whole purpose was to be forgotten by everyone else — see DEF-115.
  const day = await adjudicateDay(tx, {
    employmentId: input.employmentId,
    shiftDay,
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
  incoming: ParsedAdjustmentInput;
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
