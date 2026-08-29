/**
 * Recording a punch. T-156. `docs/tasks/156-attendance-punches.md`.
 *
 * ## ⛔ One writer, and this is it
 *
 * Bible §4.2 rule 8: *"One writer per table. If two code paths write the same table, one of them is
 * wrong. (This is the single most expensive lesson from ERP-rebuild.)"*
 *
 * The Lane B ingestor (T-182), the online terminal path, and a manager's back-office entry all call
 * `recordPunch`. None of them writes `attendance_punches` directly, and none of them re-derives the
 * shift day, the employment, or the idempotency behaviour for itself.
 *
 * ⭐ **`recordPunch` is deliberately transport-agnostic.** It knows nothing about Firestore, which
 * is what lets T-182 be a thin adapter and lets this be tested without one.
 */
import { attendancePunchesRepo, employmentRepo, type AttendancePunchRow, type Tx } from '@shareat/db';
import type { PunchIntent, PunchMethod, PunchSource } from '@shareat/db/schema';
import { toShiftDay } from './shift-day';

export class PunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PunchError';
  }
}

/**
 * ⚠️ **How long a punch may sit unsynced before a human should look at it.**
 *
 * v1 uses the same 72 hours as a HARD REJECTION (`MAX_QUEUE_AGE_MS`, `offline-replay.ts:7`) and
 * then dead-letters the punch into an IndexedDB store with no reader — landmine #14, and discovery
 * 05 §6: *"no admin/manager UI was found anywhere in the app that reads dead-lettered punches."*
 *
 * Here the event lives in Firestore rather than a private device store, so it is never unreachable
 * and there is nothing to be gained by refusing it. The number survives as the threshold at which
 * T-157 raises a `late_event_arrival` anomaly for a manager to confirm. **Same constant, opposite
 * consequence: a flag instead of a cliff.**
 */
export const LATE_ARRIVAL_THRESHOLD_MS = 72 * 60 * 60 * 1000;

export interface RecordPunchInput {
  /** The idempotency key. Client-generated, and the Firestore inbox document id. */
  clientPunchId: string;
  employmentId: string;
  occurredAt: Date;
  method: PunchMethod;
  /** What the device asserts. T-157 may disagree, and records that it did. */
  assertedIntent: PunchIntent;
  source: PunchSource;
  deviceId?: string | null;
  /** From `resolveActor` — the verified session, never a client-named person (§7.1). */
  capturedBySessionId?: string | null;
  supersedesPunchId?: string | null;
  voidReason?: string | null;
  createdBy?: string | null;
  /**
   * ⚠️ Testing seam ONLY: force the `store_id` written on the row, to prove the database refuses a
   * punch whose store disagrees with its employment. Production callers never pass this — the store
   * is derived from the employment, which is the point.
   */
  storeIdOverride?: string;
}

export interface RecordPunchResult {
  punch: AttendancePunchRow;
  /**
   * ⭐ `true` is a SUCCESS, not an error. Bible §5.1: *"a replay is a silent no-op."* The ingestor
   * will legitimately re-deliver events, and an error here would make it retry forever.
   */
  alreadyProcessed: boolean;
}

/**
 * Record one raw punch.
 *
 * ⛔ **No authorization check, and that is deliberate.** Presenting your own credential at a
 * terminal is not a privileged act — it is the thing a staffer does, authenticated by the
 * credential itself. Reading somebody else's punches is `manage_attendance`; filing one on their
 * behalf is a `manual_entry`, which its caller gates. Putting an `authorize()` here would mean a
 * staffer needs a capability to clock in.
 */
export async function recordPunch(tx: Tx, input: RecordPunchInput): Promise<RecordPunchResult> {
  if (!input.clientPunchId?.trim()) {
    throw new PunchError(
      'A punch needs a clientPunchId. It is the idempotency key, and without one a replay becomes ' +
        'a duplicate shift.',
    );
  }

  const employment = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!employment) {
    throw new PunchError(`No employment ${input.employmentId} — nobody to attribute this punch to.`);
  }

  const { row, inserted } = await attendancePunchesRepo.insertPunchIfNew(tx, {
    orgId: employment.orgId,
    // Derived from the employment, never taken from the caller — except through the testing seam,
    // which exists to prove the database refuses the mismatch.
    storeId: input.storeIdOverride ?? employment.storeId,
    personId: employment.personId,
    employmentId: employment.id,
    clientPunchId: input.clientPunchId,
    occurredAt: input.occurredAt,
    // Computed on write (bible §6), on the 05:00 calendar, never re-derived at read time.
    shiftDay: toShiftDay(input.occurredAt),
    method: input.method,
    assertedIntent: input.assertedIntent,
    deviceId: input.deviceId ?? null,
    source: input.source,
    capturedBySessionId: input.capturedBySessionId ?? null,
    supersedesPunchId: input.supersedesPunchId ?? null,
    voidReason: input.voidReason ?? null,
    createdBy: input.createdBy ?? null,
  });

  return { punch: row, alreadyProcessed: !inserted };
}

/** How late an event arrived, and whether that is worth a manager's attention. */
export function arrivalLag(punch: AttendancePunchRow): { lagMs: number; isLate: boolean } {
  const lagMs = punch.receivedAt.getTime() - punch.occurredAt.getTime();
  return { lagMs, isLate: lagMs > LATE_ARRIVAL_THRESHOLD_MS };
}

/** The punches T-157 adjudicates a day from — superseded ones already removed. */
export async function listPunchesForDay(
  tx: Tx,
  input: { employmentId: string; shiftDay: string },
): Promise<AttendancePunchRow[]> {
  return attendancePunchesRepo.listForDay(tx, input);
}
