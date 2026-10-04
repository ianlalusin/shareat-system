/**
 * Reading and changing a store's attendance policy. T-155 Part B.
 * `docs/tasks/155-shift-day-and-attendance-config.md`.
 *
 * ⭐ **`getConfigForShiftDay` is the function the whole design exists for.** T-157 calls it with the
 * day it is adjudicating, so a March day recomputed in June is judged by March's rules. Every other
 * function here exists to keep that answer honest.
 */
import { authorize, type Actor } from '@shareat/auth';
import { attendanceConfigRepo, findingsRepo, type AttendanceConfigRow, type Tx } from '@shareat/db';
import { parseShiftDay, type RawShiftDay, type ShiftDay } from './shift-day';
import { maxPayoutGapDays } from '../payroll/periods';
import { refuse } from '../shared/refusal';
import { decimal, money, type Decimal, type Money } from '@shareat/core/money';
import { parseConfigChanges, type ConfigChangesInput } from './config-input';

export type { ConfigChangesInput } from './config-input';

export class AttendanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttendanceConfigError';
  }
}

/** T-370 S3 (DEF-409, R9). The same text is mapped for `store_attendance_config_semi_monthly_two_days_check` in
 *  `apps/erp/src/lib/constraint-messages.ts` (a literal there; both are pinned by tests). */
const SEMI_MONTHLY_TWO_DAYS =
  'A semi-monthly store pays on exactly two different days of the month. Enter two payout days, for example 10,25.';
const semiMonthlyGap = (days: number): string =>
  `This semi-monthly pay cycle can run ${days} days between paydays. The Labor Code (Art. 103) allows at most 16. ` +
  'Change the payout days or the cutoff day, for example payout days 10,25 with cutoff 15.';

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

/** The eleven numeric policy columns: the brand each carries once `decimal()` has minted it (T-371 R4). */
export type NumericConfigKeys =
  | 'requiredHoursPerShift' | 'halfDayHours' | 'defaultWorkHours' | 'defaultBreakHours' | 'nightDiffMultiplier'
  | 'overtimeMultiplier' | 'overtimeFixedHourly' | 'holidayRegularMultiplier' | 'holidaySpecialNonWorkingMultiplier'
  | 'holidaySpecialWorkingMultiplier' | 'lateChargePerMinute';

/** `ConfigChanges` after parsing: the numeric columns are branded, so the writer's input type is satisfied. */
export type ParsedConfigChanges = Omit<ConfigChanges, NumericConfigKeys> & {
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

/**
 * Change a store's policy from a given shift day, by inserting a new row and retiring the old one
 * **in one transaction**. Never an in-place edit.
 *
 * T-352 / DEF-478 — `changes` and `effectiveFrom` arrive raw (the caller's own box strings) and are
 * parsed HERE, directly after `authorize()`, so an actor without the right sees the authorization
 * refusal rather than a field sentence for a form they were never allowed to submit.
 */
export async function supersedeConfig(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; effectiveFrom: ShiftDay | RawShiftDay; changes: ConfigChangesInput },
): Promise<AttendanceConfigRow> {
  await authorize(tx, actor, 'manage_store_settings', { storeId: input.storeId });

  const changes = parseConfigChanges(input.changes);
  const effectiveFrom = parseShiftDay(input.effectiveFrom);

  const live = await getLiveConfig(tx, { storeId: input.storeId });

  if (effectiveFrom <= live.effectiveFrom) {
    throw new AttendanceConfigError(
      `A new policy must take effect after the current one (${live.effectiveFrom}), not on or ` +
        `before it. Two policies claiming the same day cannot both be the answer.`,
    );
  }

  // ⛔ Backdating a policy change across days that have already been adjudicated silently moves what
  // those days paid. Refusing is cheaper than detecting it afterwards — and far cheaper than
  // explaining it to whoever was paid the other amount.
  if (await attendanceConfigRepo.hasAdjudicatedDaysFrom(tx, input.storeId, effectiveFrom)) {
    throw new AttendanceConfigError(
      `Attendance has already been computed for days on or after ${effectiveFrom}. A policy ` +
        'change from that date would silently restate what those days paid. Choose a later date, ' +
        'or void the affected days first and say why.',
    );
  }

  // T-370 S3 (DEF-409): a semi-monthly store pays on exactly two different days, and no gap between paydays may
  // exceed Art. 103's sixteen. Judged on the MERGED row (`changes` over the live row), so a store already out of
  // line is refused on ANY save until its cadence is fixed (R7), and in `lag` mode too. The DB CHECK backs the
  // two-days half; the gap depends on month lengths and `derivePeriods`, so only this function and the T-332
  // detector (the same `maxPayoutGapDays`) can judge it. Before `markSuperseded`: nothing is written on a refusal.
  const merged = { ...live, ...changes };
  if (merged.payrollPeriodType === 'semi_monthly') {
    if (merged.payoutMode === 'fixed_days' && (merged.payoutDays.length !== 2 || merged.payoutDays[0] === merged.payoutDays[1])) {
      throw refuse('supersedeConfig: a semi_monthly fixed_days store needs exactly two distinct payout days.', SEMI_MONTHLY_TWO_DAYS);
    }
    const gap = maxPayoutGapDays(
      { payrollPeriodType: merged.payrollPeriodType, semiMonthlyCutoffDay: merged.semiMonthlyCutoffDay },
      { payoutMode: merged.payoutMode, payoutLagDays: merged.payoutLagDays, payoutDays: merged.payoutDays },
    );
    if (gap > findingsRepo.PAY_INTERVAL_MAX_DAYS) {
      throw refuse(`supersedeConfig: a semi_monthly cycle runs ${gap} days between paydays, over Art. 103's limit.`, semiMonthlyGap(gap));
    }
  }

  // ⚠️ Retire the old row BEFORE inserting the new one. `store_attendance_config_live_unique` is a
  // plain (non-deferrable) partial unique index, so it fires the moment a second live row exists —
  // even mid-transaction, with the supersede one statement away. Both orders are correct at COMMIT;
  // only this one is legal at every point in between.
  await attendanceConfigRepo.markSuperseded(tx, live.id, new Date());

  return attendanceConfigRepo.insertConfig(tx, {
    ...stripLifecycle(live),
    ...changes,
    orgId: live.orgId,
    storeId: live.storeId,
    effectiveFrom,
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
function stripLifecycle(row: AttendanceConfigRow): ParsedConfigChanges {
  const { id, orgId, storeId, effectiveFrom, supersededAt, ...rest } = row;
  void id;
  void orgId;
  void storeId;
  void effectiveFrom;
  void supersededAt;
  // T-371 R4 — the inherited figures are re-written into the successor row, so they are re-minted from the stored text
  // (never cast). `0155` keeps NaN out of stored data, so these never refuse; they close the hole in the type system.
  return {
    ...rest,
    requiredHoursPerShift: decimal(rest.requiredHoursPerShift, '4,2'),
    halfDayHours: decimal(rest.halfDayHours, '4,2'),
    defaultWorkHours: decimal(rest.defaultWorkHours, '4,2'),
    defaultBreakHours: decimal(rest.defaultBreakHours, '4,2'),
    nightDiffMultiplier: decimal(rest.nightDiffMultiplier, '4,2'),
    overtimeMultiplier: decimal(rest.overtimeMultiplier, '4,2'),
    overtimeFixedHourly: rest.overtimeFixedHourly === null ? null : money(rest.overtimeFixedHourly),
    holidayRegularMultiplier: decimal(rest.holidayRegularMultiplier, '4,2'),
    holidaySpecialNonWorkingMultiplier: decimal(rest.holidaySpecialNonWorkingMultiplier, '4,2'),
    holidaySpecialWorkingMultiplier: decimal(rest.holidaySpecialWorkingMultiplier, '4,2'),
    lateChargePerMinute: money(rest.lateChargePerMinute),
  };
}
