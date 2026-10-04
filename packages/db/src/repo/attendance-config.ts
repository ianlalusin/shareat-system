/**
 * The only place SQL is written for attendance config. T-155 Part B.
 *
 * ⛔ **There is no `update` here beyond stamping `superseded_at`.** A policy change is a new row;
 * the database trigger refuses anything else. See the schema file for why.
 */
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Decimal, Money } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';
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
  anchorWindowMinutes: number;
  timeMode: TimeMode;
  halfDayOnMissingTap: boolean;
  /** ⭐ T-199. `null` = this store never auto-clears. */
  autoClockOutHour: number | null;
  maxShiftHours: number;
  defaultWorkHours: string;
  defaultBreakHours: string;

  nightDiffEnabled: boolean;
  nightDiffStartHour: number;
  nightDiffEndHour: number;
  nightDiffMultiplier: string;
  overtimeMultiplier: string;
  // ---- T-189b. Every premium is a per-store SETTING rather than a constant.
  overtimeMode: 'multiplier' | 'fixed';
  /** ⚠️ Pesos per OT hour, and only meaningful when `overtimeMode` is `fixed`. */
  overtimeFixedHourly: string | null;
  /** ⭐ One per holiday KIND, keyed to `attendance_days.holidayType`. */
  holidayRegularMultiplier: string;
  holidaySpecialNonWorkingMultiplier: string;
  holidaySpecialWorkingMultiplier: string;
  // ---- T-189c. How this store's pay periods are cut.
  payrollPeriodType: 'monthly' | 'semi_monthly' | 'weekly';
  semiMonthlyCutoffDay: number;
  payoutMode: 'lag' | 'fixed_days';
  payoutLagDays: number;
  payoutDays: number[];

  lateGraceMinutes: number;
  earlyOutGraceMinutes: number;
  undertimeGraceMinutes: number;

  latePolicy: LatePolicy;
  lateChargePerMinute: string;
  lateInfractionPoints: number;

  breakEnabled: boolean;
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

/** The (4,2) hours and multipliers, and the two (14,2) money columns: every numeric column of the table. */
type NumericConfigKey =
  | 'requiredHoursPerShift'
  | 'halfDayHours'
  | 'defaultWorkHours'
  | 'defaultBreakHours'
  | 'nightDiffMultiplier'
  | 'overtimeMultiplier'
  | 'overtimeFixedHourly'
  | 'holidayRegularMultiplier'
  | 'holidaySpecialNonWorkingMultiplier'
  | 'holidaySpecialWorkingMultiplier'
  | 'lateChargePerMinute';

/**
 * T-371 C2 — every numeric column is a `Decimal` brand of that column's own shape, minted by `decimal()`.
 * ✎R13 every policy column has a database default, so each is optional: a blank is OMITTED and the default applies.
 * `overtimeFixedHourly` is the one nullable numeric (null = no fixed rate).
 */
export type InsertConfigInput = Pick<
  SafeInsert<typeof storeAttendanceConfig>,
  'orgId' | 'storeId' | 'effectiveFrom'
> & { createdBy?: string | null } &
  Partial<
    Omit<AttendanceConfigRow, 'id' | 'supersededAt' | 'orgId' | 'storeId' | 'effectiveFrom' | NumericConfigKey>
  > & {
    requiredHoursPerShift?: Decimal<'4,2'>;
    halfDayHours?: Decimal<'4,2'>;
    defaultWorkHours?: Decimal<'4,2'>;
    defaultBreakHours?: Decimal<'4,2'>;
    nightDiffMultiplier?: Decimal<'4,2'>;
    overtimeMultiplier?: Decimal<'4,2'>;
    overtimeFixedHourly?: Money | null;
    holidayRegularMultiplier?: Decimal<'4,2'>;
    holidaySpecialNonWorkingMultiplier?: Decimal<'4,2'>;
    holidaySpecialWorkingMultiplier?: Decimal<'4,2'>;
    lateChargePerMinute?: Money;
  };

export async function insertConfig(tx: Tx, input: InsertConfigInput): Promise<AttendanceConfigRow> {
  const [row] = await tx.insert(storeAttendanceConfig).values(input).returning();
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
