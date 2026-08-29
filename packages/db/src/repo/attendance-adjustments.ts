/** The only place SQL is written for manager adjustments. T-158. */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { attendanceAdjustments, type AdjustmentKind } from '../../schema/attendance-adjustments';

export interface AttendanceAdjustmentRow {
  id: string;
  orgId: string;
  storeId: string;
  employmentId: string;
  shiftDay: string;
  kind: AdjustmentKind;
  chosenAnchorMinute: number | null;
  effectiveOutMinute: number | null;
  isHalfDay: string | null;
  reason: string | null;
  decidedBySessionId: string;
  decidedByPersonId: string;
  supersededByAdjustmentId: string | null;
  createdAt: Date;
}

export type InsertAdjustmentInput = Omit<
  AttendanceAdjustmentRow,
  'createdAt' | 'supersededByAdjustmentId'
>;

/**
 * Mint the id the new row WILL have, before inserting it.
 *
 * ⚠️ Needed because `attendance_adjustments_live_unique` is a plain (non-deferrable) partial unique
 * index: the superseding row and the row it supersedes cannot both be live for even one statement.
 * The old row must therefore be stamped FIRST — which needs the new row's id before it exists.
 * Postgres mints it, so id generation stays in one place and stays time-ordered.
 */
export async function nextAdjustmentId(tx: Tx): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
  return String((r as unknown as { id: string }[])[0]!.id);
}

/** The decisions currently in force for one person-day. */
export async function listLive(
  tx: Tx,
  input: { employmentId: string; shiftDay: string },
): Promise<AttendanceAdjustmentRow[]> {
  const rows = await tx
    .select()
    .from(attendanceAdjustments)
    .where(
      and(
        eq(attendanceAdjustments.employmentId, input.employmentId),
        eq(attendanceAdjustments.shiftDay, input.shiftDay),
        isNull(attendanceAdjustments.supersededByAdjustmentId),
      ),
    )
    .orderBy(asc(attendanceAdjustments.createdAt));
  return rows as AttendanceAdjustmentRow[];
}

/** Every decision ever made about a day, superseded ones included — the audit answer. */
export async function listAll(
  tx: Tx,
  input: { employmentId: string; shiftDay: string },
): Promise<AttendanceAdjustmentRow[]> {
  const rows = await tx
    .select()
    .from(attendanceAdjustments)
    .where(
      and(
        eq(attendanceAdjustments.employmentId, input.employmentId),
        eq(attendanceAdjustments.shiftDay, input.shiftDay),
      ),
    )
    .orderBy(asc(attendanceAdjustments.createdAt));
  return rows as AttendanceAdjustmentRow[];
}

export async function findLiveOfKind(
  tx: Tx,
  input: { employmentId: string; shiftDay: string; kind: AdjustmentKind },
): Promise<AttendanceAdjustmentRow | undefined> {
  const [row] = await tx
    .select()
    .from(attendanceAdjustments)
    .where(
      and(
        eq(attendanceAdjustments.employmentId, input.employmentId),
        eq(attendanceAdjustments.shiftDay, input.shiftDay),
        eq(attendanceAdjustments.kind, input.kind),
        isNull(attendanceAdjustments.supersededByAdjustmentId),
      ),
    )
    .limit(1);
  return row as AttendanceAdjustmentRow | undefined;
}

export async function insertAdjustment(
  tx: Tx,
  input: InsertAdjustmentInput,
): Promise<AttendanceAdjustmentRow> {
  const [row] = await tx.insert(attendanceAdjustments).values(input).returning();
  return row as AttendanceAdjustmentRow;
}

/** Stamp the old decision as superseded. The ONLY update the trigger permits. */
export async function markSuperseded(tx: Tx, id: string, bySupersedingId: string): Promise<void> {
  await tx
    .update(attendanceAdjustments)
    .set({ supersededByAdjustmentId: bySupersedingId })
    .where(eq(attendanceAdjustments.id, id));
}
