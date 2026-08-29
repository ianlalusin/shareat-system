/**
 * Reading and changing a store's attendance policy. T-155 Part B.
 * `docs/tasks/155-shift-day-and-attendance-config.md`.
 *
 * ⭐ **`getConfigForShiftDay` is the function the whole design exists for.** T-157 calls it with the
 * day it is adjudicating, so a March day recomputed in June is judged by March's rules. Every other
 * function here exists to keep that answer honest.
 */
import { authorize, type Actor } from '@shareat/auth';
import { attendanceConfigRepo, type AttendanceConfigRow, type Tx } from '@shareat/db';
import type { ShiftDay } from './shift-day';

export class AttendanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttendanceConfigError';
  }
}

/** The policy in force right now. */
export async function getLiveConfig(tx: Tx, input: { storeId: string }): Promise<AttendanceConfigRow> {
  const row = await attendanceConfigRepo.findLive(tx, input.storeId);
  if (!row) {
    throw new AttendanceConfigError(
      `Store ${input.storeId} has no attendance config. Every store gets one at creation — a store ` +
        'without one is not "using defaults", it is unconfigured, and an unconfigured attendance ' +
        'policy fails quietly in the direction that looks fine.',
    );
  }
  return row;
}

/**
 * The policy that governed a given shift day.
 *
 * ⚠️ **Never substitute the live config for a missing historical one.** A day before any config
 * existed cannot be adjudicated, and saying so is the whole point — silently judging it by today's
 * rules is exactly the retroactive-pay move this table prevents.
 */
export async function getConfigForShiftDay(
  tx: Tx,
  input: { storeId: string; day: ShiftDay },
): Promise<AttendanceConfigRow> {
  const row = await attendanceConfigRepo.findForDay(tx, input.storeId, input.day);
  if (!row) {
    throw new AttendanceConfigError(
      `No attendance config governed ${input.day} at store ${input.storeId} — the earliest config ` +
        'starts after that day. This day cannot be adjudicated without deciding, explicitly, which ' +
        'policy applied to it.',
    );
  }
  return row;
}

/** The fields a supersede may change — everything except the row's own identity and lifecycle. */
export type ConfigChanges = Partial<
  Omit<
    AttendanceConfigRow,
    'id' | 'orgId' | 'storeId' | 'effectiveFrom' | 'supersededAt'
  >
>;

/**
 * Change a store's policy from a given shift day, by inserting a new row and retiring the old one
 * **in one transaction**. Never an in-place edit.
 */
export async function supersedeConfig(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; effectiveFrom: ShiftDay; changes: ConfigChanges },
): Promise<AttendanceConfigRow> {
  await authorize(tx, actor, 'manage_store_settings', { storeId: input.storeId });

  const live = await getLiveConfig(tx, { storeId: input.storeId });

  if (input.effectiveFrom <= live.effectiveFrom) {
    throw new AttendanceConfigError(
      `A new policy must take effect after the current one (${live.effectiveFrom}), not on or ` +
        `before it. Two policies claiming the same day cannot both be the answer.`,
    );
  }

  // ⛔ Backdating a policy change across days that have already been adjudicated silently moves what
  // those days paid. Refusing is cheaper than detecting it afterwards — and far cheaper than
  // explaining it to whoever was paid the other amount.
  if (await attendanceConfigRepo.hasAdjudicatedDaysFrom(tx, input.storeId, input.effectiveFrom)) {
    throw new AttendanceConfigError(
      `Attendance has already been computed for days on or after ${input.effectiveFrom}. A policy ` +
        'change from that date would silently restate what those days paid. Choose a later date, ' +
        'or void the affected days first and say why.',
    );
  }

  // ⚠️ Retire the old row BEFORE inserting the new one. `store_attendance_config_live_unique` is a
  // plain (non-deferrable) partial unique index, so it fires the moment a second live row exists —
  // even mid-transaction, with the supersede one statement away. Both orders are correct at COMMIT;
  // only this one is legal at every point in between.
  await attendanceConfigRepo.markSuperseded(tx, live.id, new Date());

  return attendanceConfigRepo.insertConfig(tx, {
    ...stripLifecycle(live),
    ...input.changes,
    orgId: live.orgId,
    storeId: live.storeId,
    effectiveFrom: input.effectiveFrom,
    createdBy: actor.personId,
  });
}

/**
 * Give a store its first policy. Idempotent — a store that already has one keeps it, because
 * re-seeding must never quietly restate a policy somebody deliberately changed.
 */
export async function seedAttendanceConfig(
  tx: Tx,
  input: { orgId: string; storeId: string; effectiveFrom: string; createdBy?: string | null },
): Promise<AttendanceConfigRow> {
  const existing = await attendanceConfigRepo.findLive(tx, input.storeId);
  if (existing) return existing;
  return attendanceConfigRepo.insertConfig(tx, input);
}

/** Everything except the row's own identity and lifecycle — i.e. what a successor inherits. */
function stripLifecycle(row: AttendanceConfigRow): ConfigChanges {
  const { id, orgId, storeId, effectiveFrom, supersededAt, ...rest } = row;
  void id;
  void orgId;
  void storeId;
  void effectiveFrom;
  void supersededAt;
  return rest;
}
