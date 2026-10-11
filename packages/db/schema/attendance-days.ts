/**
 * attendance_days — the ADJUDICATED day. T-157.
 * `docs/tasks/157-attendance-adjudication.md`, `docs/plans/phase-4-attendance.md` §4.1.
 *
 * ## The third of three tables, and the split is the point
 *
 * v1's `AttendanceSessionPlain` carries all three of these in one document — the raw taps, the
 * computation, and the manager's overlay — held apart only by a comment insisting the overlay
 * fields *"NEVER touch rawClockIn / rawClockOut / computedHours."* Here:
 *
 *   `attendance_punches`      the FACT      append-only
 *   `attendance_adjustments`  the DECISION  append-and-supersede (T-158)
 *   `attendance_days`         the DERIVED   recomputable, then frozen
 *
 * ⭐ That is what makes *recompute from truth* mechanically possible. v1 cannot do it, because its
 * overlay lives inside the row a recompute would overwrite.
 *
 * ## ⛔ `attendanceConfigId` is the historical-integrity link
 *
 * Discovery 15 "Intent worth preserving" #6: *a payslip must never disagree with what was actually
 * recorded, even if today's config has since changed.* The day names the config row it was computed
 * under, so re-deriving a March day in June gives **March's** answer. v1 keeps the same promise by
 * refusing to recompute at all — which also means it cannot apply a genuine repair.
 *
 * ## Every duration is an INTEGER MINUTE
 *
 * `numeric` hours appear only where payroll reads them, derived at that boundary. Bible §6 bans
 * floats for money and hours are money one multiplication away — see `compute-day.ts`.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { attendancePunches } from './attendance-punches';
import { storeAttendanceConfig } from './attendance-config';
import { employments } from './employment';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * ⚠️ v1's `SessionStatus` also has `auto_paired`, `half_day` and `edited` — three values that encode
 * *facts about the computation* inside the *status*. `half_day` duplicates `isHalfDay`; `edited`
 * duplicates "an adjustment row exists"; `auto_paired` means "computed and nothing was wrong". That
 * is landmine #12 (*two switches governed one behaviour*) in enum form.
 *
 * **v2's status answers exactly one question: how far can this day be trusted for pay.**
 */
export const ATTENDANCE_DAY_STATUSES = [
  /** An in with no out yet — the shift is still running. */
  'open',
  /** Computed, and nothing needs a human. */
  'computed',
  /** Computed, but an anomaly means a manager must settle it before it can pay. */
  'needs_review',
  /** A manager has signed it off. */
  'verified',
  /** Discarded — duplicate or erroneous. Contributes nothing, and its punches remain. */
  'voided',
] as const;
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number];

/** The statuses payroll may pay against. Exported so nobody re-derives it slightly differently. */
export const PAYABLE_DAY_STATUSES: readonly AttendanceDayStatus[] = ['computed', 'verified'];

export const HOLIDAY_TYPES = ['regular', 'special_non_working', 'special_working'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];

export const attendanceDays = pgTable(
  'attendance_days',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),

    /** The 05:00 calendar. One row per person per shift day, enforced below. */
    shiftDay: date('shift_day').notNull(),

    /** ⭐ The historical-integrity link. See the header. */
    attendanceConfigId: uuid('attendance_config_id')
      .notNull()
      .references(() => storeAttendanceConfig.id, { onDelete: 'restrict' }),

    /** The evidence, referenced rather than copied. */
    firstInPunchId: uuid('first_in_punch_id').references(() => attendancePunches.id, { onDelete: 'restrict' }),
    lastOutPunchId: uuid('last_out_punch_id').references(() => attendancePunches.id, { onDelete: 'restrict' }),

    /** Minutes from the shift day's 05:00 start. */
    anchorMinute: integer('anchor_minute'),
    anchorMode: text('anchor_mode', { enum: ['exact', 'previous', 'next', 'unallowed'] }).notNull(),
    endMinute: integer('end_minute'),

    /** ⭐ After every step in the task spec's §1 ordering — cap, undertime grace, short shift, break. */
    computedMinutes: integer('computed_minutes').notNull().default(0),
    isHalfDay: boolean('is_half_day').notNull().default(false),
    cappedAtRequired: boolean('capped_at_required').notNull().default(false),
    /**
     * ⛔ **RAW.** `max(0, clockIn − anchor)`, never grace-adjusted — T-157b. It was previously
     * stored with `lateGraceMinutes` already subtracted, so a 5-minute lateness at a store whose
     * grace is 5 recorded as 0 and the fact was gone. Grace belongs to CHARGING, not to RECORDING.
     */
    lateMinutes: integer('late_minutes').notNull().default(0),
    /** What a late policy may actually charge: `max(0, lateMinutes − lateGraceMinutes)`. */
    lateChargeableMinutes: integer('late_chargeable_minutes').notNull().default(0),
    /** ⭐ `max(0, targetEnd − actualOut)`. Recorded even when the day is credited in full. */
    earlyOutMinutes: integer('early_out_minutes').notNull().default(0),
    undertimeForgivenMinutes: integer('undertime_forgiven_minutes').notNull().default(0),

    breakMinutes: integer('break_minutes').notNull().default(0),
    allowableBreakMinutes: integer('allowable_break_minutes').notNull().default(0),
    breakOverMinutes: integer('break_over_minutes').notNull().default(0),

    nightDiffMinutes: integer('night_diff_minutes').notNull().default(0),

    isHoliday: boolean('is_holiday').notNull().default(false),
    holidayType: text('holiday_type', { enum: HOLIDAY_TYPES }),
    holidayMinutes: integer('holiday_minutes').notNull().default(0),

    /** ⛔ The short-shift / late-out remainder. **Recorded, never paid here** — the approval gate is
     *  Phase 5, and auto-paying it is exactly what the pending status exists to prevent. */
    pendingOtMinutes: integer('pending_ot_minutes').notNull().default(0),

    status: text('status', { enum: ATTENDANCE_DAY_STATUSES }).notNull(),
    anomalies: text('anomalies').array().notNull().default(sql`'{}'::text[]`),
    /** Why it came out this way, in sentences. A payroll dispute is answered by reading it. */
    explain: text('explain').array().notNull().default(sql`'{}'::text[]`),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Cheap staleness detection: a punch arriving later changes this. */
    computedFromPunchCount: integer('computed_from_punch_count').notNull().default(0),

    /**
     * ⛔ Once frozen, recomputation REFUSES rather than overwriting — the payslip guarantee, enforced
     * by trigger rather than by the service remembering. The column lands now; **Phase 5 sets it**,
     * which is why the FK is deliberately absent until the pay-run table exists.
     */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    frozenByPayRunId: uuid('frozen_by_pay_run_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** One row per person per shift day. */
    uniqueIndex('attendance_days_employment_shift_day_unique').on(t.employmentId, t.shiftDay),
    index('attendance_days_store_shift_day_idx').on(t.storeId, t.shiftDay),
    index('attendance_days_status_idx').on(t.storeId, t.status),
    index('attendance_days_config_idx').on(t.attendanceConfigId),

    check('attendance_days_status_check', sql`${t.status} in ('open','computed','needs_review','verified','voided')`),
    check('attendance_days_anchor_mode_check', sql`${t.anchorMode} in ('exact','previous','next','unallowed')`),
    check('attendance_days_holiday_type_check', sql`${t.holidayType} is null or ${t.holidayType} in ('regular','special_non_working','special_working')`),
    /** Every duration is non-negative. A negative paid minute is not a small error. */
    check(
      'attendance_days_non_negative_check',
      sql`${t.computedMinutes} >= 0 and ${t.lateMinutes} >= 0 and ${t.breakMinutes} >= 0
          and ${t.breakOverMinutes} >= 0 and ${t.nightDiffMinutes} >= 0 and ${t.pendingOtMinutes} >= 0
          and ${t.undertimeForgivenMinutes} >= 0 and ${t.holidayMinutes} >= 0
          and ${t.lateChargeableMinutes} >= 0 and ${t.earlyOutMinutes} >= 0`,
    ),
    /** Frozen is a pair or neither, like every other two-column fact in this schema. */
    check(
      'attendance_days_frozen_pair_check',
      sql`(${t.frozenAt} is null) = (${t.frozenByPayRunId} is null)`,
    ),
    check('attendance_days_holiday_pair_check', sql`${t.isHoliday} or ${t.holidayType} is null`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'attendance_days_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'attendance_days_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
