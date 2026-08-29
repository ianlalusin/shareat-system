/**
 * The only place SQL is written for attendance punches. T-156.
 *
 * ⛔ There is exactly ONE write function, and it inserts. No update, no delete — the table's
 * triggers refuse both, and a repo function offering them would only be a way to discover that
 * at runtime.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  attendancePunches,
  type PunchIntent,
  type PunchMethod,
  type PunchSource,
} from '../../schema/attendance-punches';

export interface AttendancePunchRow {
  id: string;
  orgId: string;
  storeId: string;
  personId: string;
  employmentId: string;
  clientPunchId: string;
  occurredAt: Date;
  shiftDay: string;
  method: PunchMethod;
  assertedIntent: PunchIntent;
  deviceId: string | null;
  source: PunchSource;
  capturedBySessionId: string | null;
  receivedAt: Date;
  supersedesPunchId: string | null;
  voidReason: string | null;
}

export interface InsertPunchInput {
  orgId: string;
  storeId: string;
  personId: string;
  employmentId: string;
  clientPunchId: string;
  occurredAt: Date;
  shiftDay: string;
  method: PunchMethod;
  assertedIntent: PunchIntent;
  deviceId?: string | null;
  source: PunchSource;
  capturedBySessionId?: string | null;
  supersedesPunchId?: string | null;
  voidReason?: string | null;
  createdBy?: string | null;
}

/**
 * Insert, or no-op if this `clientPunchId` has already been seen.
 *
 * ⭐ `on conflict do nothing` and then read back, rather than a read-then-insert: the read-then-
 * insert loses the race the offline lane exists to survive, and bible §5.1 requires a replay to be
 * "a silent no-op" rather than an error the ingestor would retry forever.
 */
export async function insertPunchIfNew(
  tx: Tx,
  input: InsertPunchInput,
): Promise<{ row: AttendancePunchRow; inserted: boolean }> {
  const [inserted] = await tx
    .insert(attendancePunches)
    .values(input)
    .onConflictDoNothing({ target: attendancePunches.clientPunchId })
    .returning();

  if (inserted) return { row: inserted as AttendancePunchRow, inserted: true };

  const existing = await findByClientPunchId(tx, input.clientPunchId);
  if (!existing) {
    // Only reachable if the conflicting row belongs to another org and RLS hides it — which is
    // itself a finding, not a retryable condition.
    throw new Error(
      `Punch ${input.clientPunchId} conflicted on insert but is not readable — the idempotency key ` +
        'is in use by a row this principal cannot see.',
    );
  }
  return { row: existing, inserted: false };
}

export async function findByClientPunchId(
  tx: Tx,
  clientPunchId: string,
): Promise<AttendancePunchRow | undefined> {
  const [row] = await tx
    .select()
    .from(attendancePunches)
    .where(eq(attendancePunches.clientPunchId, clientPunchId))
    .limit(1);
  return row as AttendancePunchRow | undefined;
}

/**
 * Every punch for one employment on one shift day, oldest first, EXCLUDING any that a later punch
 * supersedes. T-157 adjudicates from exactly this list.
 */
export async function listForDay(
  tx: Tx,
  input: { employmentId: string; shiftDay: string },
): Promise<AttendancePunchRow[]> {
  const rows = await tx
    .select()
    .from(attendancePunches)
    .where(
      and(
        eq(attendancePunches.employmentId, input.employmentId),
        eq(attendancePunches.shiftDay, input.shiftDay),
        sql`not exists (
          select 1 from attendance_punches c
          where c.supersedes_punch_id = ${attendancePunches.id}
        )`,
      ),
    )
    .orderBy(asc(attendancePunches.occurredAt), asc(attendancePunches.id));
  return rows as AttendancePunchRow[];
}

/** Punches for a store across a shift-day range — the roster and feed reads (T-166). */
export async function listForStoreRange(
  tx: Tx,
  input: { storeId: string; from: string; to: string },
): Promise<AttendancePunchRow[]> {
  const rows = await tx
    .select()
    .from(attendancePunches)
    .where(
      and(
        eq(attendancePunches.storeId, input.storeId),
        gte(attendancePunches.shiftDay, input.from),
        lte(attendancePunches.shiftDay, input.to),
      ),
    )
    .orderBy(asc(attendancePunches.occurredAt));
  return rows as AttendancePunchRow[];
}
