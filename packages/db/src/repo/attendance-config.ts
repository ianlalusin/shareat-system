/**
 * The only place SQL is written for attendance config. T-155 Part B.
 *
 * ⛔ **There is no `update` here beyond stamping `superseded_at`.** A policy change is a new row;
 * the database trigger refuses anything else. See the schema file for why.
 */
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { storeAttendanceConfig, type LatePolicy, type TimeMode } from '../../schema/attendance-config';

export interface AttendanceConfigRow {
  id: string;
  orgId: string;
  storeId: string;
  effectiveFrom: string;
  supersededAt: Date | null;

  requiredHoursPerShift: string;
  halfDayHours: string;
  shortShiftHalfDayOt: boolean;
  allowedShiftStartHours: number[];
  timeMode: TimeMode;
  halfDayOnMissingTap: boolean;
  defaultWorkHours: string;
  defaultBreakHours: string;

  nightDiffEnabled: boolean;
  nightDiffStartHour: number;
  nightDiffEndHour: number;
  nightDiffMultiplier: string;
  overtimeMultiplier: string;

  lateGraceMinutes: number;
  earlyOutGraceMinutes: number;
  undertimeGraceMinutes: number;

  latePolicy: LatePolicy;
  lateChargePerMinute: string;
  lateInfractionPoints: number;

  breakEnabled: boolean;
  credentialPasscode: boolean;
  credentialNfc: boolean;
  credentialFingerprint: boolean;
  credentialFace: boolean;
}

/** The row currently in force. */
export async function findLive(tx: Tx, storeId: string): Promise<AttendanceConfigRow | undefined> {
  const [row] = await tx
    .select()
    .from(storeAttendanceConfig)
    .where(and(eq(storeAttendanceConfig.storeId, storeId), isNull(storeAttendanceConfig.supersededAt)))
    .limit(1);
  return row as AttendanceConfigRow | undefined;
}

/**
 * ⭐ The row that governed a given shift day — the function that makes the payslip guarantee real.
 *
 * The greatest `effective_from` at or before the day. **Not** the live row, and not the row whose
 * `superseded_at` window contains it: a supersede stamps the moment the change was MADE, while
 * `effective_from` says the day it takes effect, and those are different questions.
 */
export async function findForDay(
  tx: Tx,
  storeId: string,
  day: string,
): Promise<AttendanceConfigRow | undefined> {
  const [row] = await tx
    .select()
    .from(storeAttendanceConfig)
    .where(
      and(eq(storeAttendanceConfig.storeId, storeId), lte(storeAttendanceConfig.effectiveFrom, day)),
    )
    .orderBy(desc(storeAttendanceConfig.effectiveFrom))
    .limit(1);
  return row as AttendanceConfigRow | undefined;
}

export type InsertConfigInput = Partial<
  Omit<AttendanceConfigRow, 'id' | 'supersededAt' | 'orgId' | 'storeId' | 'effectiveFrom'>
> & {
  orgId: string;
  storeId: string;
  effectiveFrom: string;
  createdBy?: string | null;
};

export async function insertConfig(tx: Tx, input: InsertConfigInput): Promise<AttendanceConfigRow> {
  const [row] = await tx.insert(storeAttendanceConfig).values(input as never).returning();
  return row as AttendanceConfigRow;
}

/** Stamp a live row as superseded. The ONLY update the trigger permits. */
export async function markSuperseded(tx: Tx, id: string, at: Date): Promise<void> {
  await tx
    .update(storeAttendanceConfig)
    .set({ supersededAt: at })
    .where(eq(storeAttendanceConfig.id, id));
}

/** Whether any adjudicated day at or after `day` already exists for this store (T-157). */
export async function hasAdjudicatedDaysFrom(tx: Tx, storeId: string, day: string): Promise<boolean> {
  // ⚠️ `attendance_days` arrives with T-157. Until then there is nothing to protect, and asking a
  // table that does not exist would be an error rather than a `false` — so this checks the
  // catalogue first. The guard becomes live the moment the table lands, with no edit here.
  const exists = await tx.execute<{ present: boolean }>(sql`
    select exists (select 1 from information_schema.tables where table_name = 'attendance_days') as present`);
  const present = (exists as unknown as { present: boolean }[])[0]?.present;
  if (!present) return false;

  const result = await tx.execute<{ present: boolean }>(sql`
    select exists (
      select 1 from attendance_days
      where store_id = ${storeId} and shift_day >= ${day}::date
    ) as present`);
  return Boolean((result as unknown as { present: boolean }[])[0]?.present);
}
