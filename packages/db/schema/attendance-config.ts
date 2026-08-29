/**
 * store_attendance_config — per-store attendance policy, EFFECTIVE-DATED. T-155 Part B.
 * `docs/tasks/155-shift-day-and-attendance-config.md`.
 *
 * ## ⭐ Why rows are immutable and superseded rather than updated
 *
 * Discovery 15 "Intent worth preserving" #6, quoting `ERP-rebuild/src/lib/actions/payroll.actions.ts:15-18`:
 *
 * > *"A payslip must never disagree with what was actually recorded, even if today's config has
 * > since changed… **This is a historical-integrity requirement, not an implementation shortcut** —
 * > it must survive the SQL rewrite."*
 *
 * v1 keeps that promise by REFUSING to recompute — it reads a stored `payrollComputedHours` and
 * never re-derives it. That works, and it means a genuine repair (a corrected punch, a fixed bug)
 * cannot be applied without either lying about history or hand-patching stored hours.
 *
 * Here the config row is immutable and an `attendance_days` row names the row it was computed
 * under. Recomputing a March day in June is deterministic and yields **March's** answer, so
 * recompute-from-truth and historical integrity stop being in tension. One foreign key, versus
 * snapshotting twenty columns onto every person-day.
 *
 * The repo already supersedes rather than updates for `person_roles` and `person_grants`, and
 * discovery 15 §5 records that v1 does the same for pay rates — *"changes to a staffer's rate are
 * versioned, never overwritten, so a past payslip can be reconstructed against the rate that was
 * actually in force."* Same argument, same shape.
 *
 * ## ⚠️ Every column is NOT NULL with a default, so "unset" cannot exist
 *
 * The exact reasoning `stores.remittanceCadence` already carries (T-152): *"An unset cadence is the
 * same defect class as an unmapped expense category — it fails quietly, in the direction that looks
 * fine."* v1's `enabledCredentials` and `breakEnabled` are both **optional** and merged with
 * defaults at read time, which is that hazard one layer up — a store doc written before the field
 * existed silently means "all methods enabled".
 *
 * Every default below is v1's, read from `ERP-rebuild/src/types/attendance-config.ts`
 * (`DEFAULT_ATTENDANCE_CONFIG`) rather than chosen here.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * ⭐ Three modes, MUTUALLY EXCLUSIVE by design (v1 `attendance-config.ts:73-78`):
 *   record_only        — store the minutes, feed the performance score, no money.
 *   charge_per_minute  — a real payslip deduction at `lateChargePerMinute`.
 *   infraction         — a points-only disciplinary record, no money.
 * Defaulting to `record_only` is deliberate in v1 and kept: *"a store must opt into charging money
 * for lateness. Defaulting to a charge would start deducting pay the moment a manager touched the
 * new pill, before anyone had agreed a rate."*
 */
export const LATE_POLICIES = ['record_only', 'charge_per_minute', 'infraction'] as const;
export type LatePolicy = (typeof LATE_POLICIES)[number];

/** `open` = free clock in/out, hours from actual punches. `fixed` = a posted shift grid. */
export const TIME_MODES = ['open', 'fixed'] as const;
export type TimeMode = (typeof TIME_MODES)[number];

export const storeAttendanceConfig = pgTable(
  'store_attendance_config',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** The SHIFT DAY from which this row governs. Not a timestamp — policy changes on a day. */
    effectiveFrom: date('effective_from').notNull(),
    /** Stamped when the next row takes over. NULL = this is the live row. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),

    // ---- Shift shape -----------------------------------------------------------------
    /** v1 default 9. "Total required hours per shift INCLUDING break (e.g. Lipa 10, Malvar 9)." */
    requiredHoursPerShift: numeric('required_hours_per_shift', { precision: 4, scale: 2 })
      .notNull()
      .default('9'),
    /** v1 default 5. The hours that constitute a half day under the short-shift rule. */
    halfDayHours: numeric('half_day_hours', { precision: 4, scale: 2 }).notNull().default('5'),
    /** v1 default false — opt-in, so no store's pay moved when the rule shipped. */
    shortShiftHalfDayOt: boolean('short_shift_half_day_ot').notNull().default(false),
    /**
     * ⭐ The one non-scalar column, and the reasoning is in the task spec §B.3: landmine #2 forbids
     * MAPS-as-records — a map standing in for a row with fields. A set of small integers has no
     * fields, no identity and no lifecycle; a child table would give every hour a uuid and a
     * `created_at` in order to store the number 14. Normalised sorted-and-distinct by CHECK, so no
     * reader ever has to defend against `[14, 9, 9]`.
     */
    allowedShiftStartHours: integer('allowed_shift_start_hours')
      .array()
      .notNull()
      .default(sql`'{9,10,11,14,15,16,17,18}'::integer[]`),
    timeMode: text('time_mode', { enum: TIME_MODES }).notNull().default('open'),
    halfDayOnMissingTap: boolean('half_day_on_missing_tap').notNull().default(false),
    defaultWorkHours: numeric('default_work_hours', { precision: 4, scale: 2 }).notNull().default('8'),
    defaultBreakHours: numeric('default_break_hours', { precision: 4, scale: 2 }).notNull().default('1'),

    // ---- Premiums --------------------------------------------------------------------
    nightDiffEnabled: boolean('night_diff_enabled').notNull().default(true),
    /** v1 default 22:00–06:00. ⚠️ These were hardcoded in v1 while the settings UI *appeared* to
     *  control them — a control that looks real and is not. Read, here, always. */
    nightDiffStartHour: integer('night_diff_start_hour').notNull().default(22),
    nightDiffEndHour: integer('night_diff_end_hour').notNull().default(6),
    nightDiffMultiplier: numeric('night_diff_multiplier', { precision: 4, scale: 2 }).notNull().default('1.10'),
    overtimeMultiplier: numeric('overtime_multiplier', { precision: 4, scale: 2 }).notNull().default('1.25'),

    // ---- Grace, all defaulting to 0 --------------------------------------------------
    /**
     * ⭐ All three default to 0 ON PURPOSE, and it is a discipline worth naming: v1 shipped
     * `earlyOutGraceMinutes` at 0 *"so no existing store's pay silently moved when the feature
     * shipped."* Never retroactively change pay by shipping a fix.
     */
    lateGraceMinutes: integer('late_grace_minutes').notNull().default(0),
    /** Softens the hour-FLOOR on clock-out: without it, letting a closer go at 23:45 costs the
     *  whole remaining 45 minutes rather than the 15 actually lost. */
    earlyOutGraceMinutes: integer('early_out_grace_minutes').notNull().default(0),
    /** A policy credit against the day's REQUIRED total — not the same thing as the one above,
     *  and applied BEFORE the short-shift rule so the two never fight over one day. */
    undertimeGraceMinutes: integer('undertime_grace_minutes').notNull().default(0),

    // ---- Late policy -----------------------------------------------------------------
    latePolicy: text('late_policy', { enum: LATE_POLICIES }).notNull().default('record_only'),
    lateChargePerMinute: numeric('late_charge_per_minute', { precision: 14, scale: 2 }).notNull().default('0'),
    lateInfractionPoints: integer('late_infraction_points').notNull().default(1),

    // ---- Terminal ---------------------------------------------------------------------
    breakEnabled: boolean('break_enabled').notNull().default(true),
    /**
     * ⭐ The per-method kill switches — bible §5.3 **hot-set item 3**, and explicitly *"a NEW cache
     * addition, not a port"*. Landmine #15: v1 does not cache these offline, so a terminal keeps
     * accepting a method an admin has just disabled and the rejection surfaces only at sync time,
     * as a silent dead letter. Caching them is a bug fix.
     */
    credentialPasscode: boolean('credential_passcode').notNull().default(true),
    credentialNfc: boolean('credential_nfc').notNull().default(true),
    credentialFingerprint: boolean('credential_fingerprint').notNull().default(true),
    credentialFace: boolean('credential_face').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('store_attendance_config_store_id_idx').on(t.storeId),
    index('store_attendance_config_store_effective_idx').on(t.storeId, t.effectiveFrom),

    /** Exactly one LIVE config per store — the partial-unique pattern used throughout this repo. */
    uniqueIndex('store_attendance_config_live_unique')
      .on(t.storeId)
      .where(sql`${t.supersededAt} is null`),
    uniqueIndex('store_attendance_config_store_effective_unique').on(t.storeId, t.effectiveFrom),

    check('store_attendance_config_time_mode_check', sql`${t.timeMode} in ('open','fixed')`),
    check('store_attendance_config_late_policy_check', sql`${t.latePolicy} in ('record_only','charge_per_minute','infraction')`),
    check(
      'store_attendance_config_night_window_check',
      sql`${t.nightDiffStartHour} between 0 and 23 and ${t.nightDiffEndHour} between 0 and 23`,
    ),
    /**
     * ⭐ A store that switched to charging and left the rate at zero has a policy that LOOKS
     * enforced and costs nothing — the Dolibarr `outstanding_limit` failure mode (Phase 2 plan §7:
     * *"a control that looks real and is not"*), applied to pay.
     */
    check(
      'store_attendance_config_charge_rate_check',
      sql`${t.latePolicy} <> 'charge_per_minute' or ${t.lateChargePerMinute} > 0`,
    ),
    check('store_attendance_config_half_day_below_required_check', sql`${t.halfDayHours} < ${t.requiredHoursPerShift}`),
    check('store_attendance_config_positive_hours_check', sql`${t.requiredHoursPerShift} > 0 and ${t.halfDayHours} > 0`),
    check(
      'store_attendance_config_grace_non_negative_check',
      sql`${t.lateGraceMinutes} >= 0 and ${t.earlyOutGraceMinutes} >= 0 and ${t.undertimeGraceMinutes} >= 0`,
    ),
    // NOTE: the allowed-hours normalisation (non-empty, all within 0..23, sorted and distinct as
    // stored) is an array CHECK that Drizzle's builder cannot express; it is hand-added in the
    // migration, the same way `person_identities` documents its own expression index.
  ],
);
