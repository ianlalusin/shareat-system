/**
 * The only place SQL is written for adjudicated days. T-157.
 *
 * ⛔ No `update` that sets computed columns on a frozen day exists here — the trigger refuses it,
 * and a repo function offering it would only be a way to find that out at runtime.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  attendanceDays,
  type AttendanceDayStatus,
  type HolidayType,
} from '../../schema/attendance-days';

export interface AttendanceDayRow {
  id: string;
  orgId: string;
  storeId: string;
  personId: string;
  employmentId: string;
  shiftDay: string;
  attendanceConfigId: string;
  firstInPunchId: string | null;
  lastOutPunchId: string | null;
  anchorMinute: number | null;
  anchorMode: 'exact' | 'previous' | 'next' | 'unallowed';
  endMinute: number | null;
  computedMinutes: number;
  isHalfDay: boolean;
  cappedAtRequired: boolean;
  lateMinutes: number;
  undertimeForgivenMinutes: number;
  breakMinutes: number;
  allowableBreakMinutes: number;
  breakOverMinutes: number;
  nightDiffMinutes: number;
  isHoliday: boolean;
  holidayType: HolidayType | null;
  holidayMinutes: number;
  pendingOtMinutes: number;
  status: AttendanceDayStatus;
  anomalies: string[];
  explain: string[];
  computedAt: Date;
  computedFromPunchCount: number;
  frozenAt: Date | null;
  frozenByPayRunId: string | null;
}

export type UpsertDayInput = Omit<
  AttendanceDayRow,
  'id' | 'computedAt' | 'frozenAt' | 'frozenByPayRunId'
>;

export async function findDay(
  tx: Tx,
  input: { employmentId: string; shiftDay: string },
): Promise<AttendanceDayRow | undefined> {
  const [row] = await tx
    .select()
    .from(attendanceDays)
    .where(and(eq(attendanceDays.employmentId, input.employmentId), eq(attendanceDays.shiftDay, input.shiftDay)))
    .limit(1);
  return row as AttendanceDayRow | undefined;
}

/**
 * Insert or replace the derived row for one person-day.
 *
 * ⚠️ `updatedAt` is set only when something actually changed, so invariant 10 (recomputing an
 * unchanged day is idempotent) is observable rather than merely claimed.
 */
export async function upsertDay(tx: Tx, input: UpsertDayInput): Promise<AttendanceDayRow> {
  const [row] = await tx
    .insert(attendanceDays)
    .values(input)
    .onConflictDoUpdate({
      target: [attendanceDays.employmentId, attendanceDays.shiftDay],
      set: {
        attendanceConfigId: input.attendanceConfigId,
        firstInPunchId: input.firstInPunchId,
        lastOutPunchId: input.lastOutPunchId,
        anchorMinute: input.anchorMinute,
        anchorMode: input.anchorMode,
        endMinute: input.endMinute,
        computedMinutes: input.computedMinutes,
        isHalfDay: input.isHalfDay,
        cappedAtRequired: input.cappedAtRequired,
        lateMinutes: input.lateMinutes,
        undertimeForgivenMinutes: input.undertimeForgivenMinutes,
        breakMinutes: input.breakMinutes,
        allowableBreakMinutes: input.allowableBreakMinutes,
        breakOverMinutes: input.breakOverMinutes,
        nightDiffMinutes: input.nightDiffMinutes,
        isHoliday: input.isHoliday,
        holidayType: input.holidayType,
        holidayMinutes: input.holidayMinutes,
        pendingOtMinutes: input.pendingOtMinutes,
        status: input.status,
        anomalies: input.anomalies,
        explain: input.explain,
        computedAt: new Date(),
        computedFromPunchCount: input.computedFromPunchCount,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as AttendanceDayRow;
}

export async function listDays(
  tx: Tx,
  input: { storeId: string; from: string; to: string },
): Promise<AttendanceDayRow[]> {
  const rows = await tx
    .select()
    .from(attendanceDays)
    .where(
      and(
        eq(attendanceDays.storeId, input.storeId),
        gte(attendanceDays.shiftDay, input.from),
        lte(attendanceDays.shiftDay, input.to),
      ),
    )
    .orderBy(asc(attendanceDays.shiftDay));
  return rows as AttendanceDayRow[];
}
