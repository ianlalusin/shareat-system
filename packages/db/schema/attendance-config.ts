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
/** T-189b. How an overtime hour is priced. */
/** T-189c. How a store's pay periods are cut. v1's `PayrollConfig.periodType`. */
/** T-189d. How payday is set. Ian: "the payout date must be configurable also." */
export const PAYOUT_MODES = ['lag', 'fixed_days'] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

export const PAYROLL_PERIOD_TYPES = ['monthly', 'semi_monthly', 'weekly'] as const;
export type PayrollPeriodType = (typeof PAYROLL_PERIOD_TYPES)[number];

export const OVERTIME_MODES = ['multiplier', 'fixed'] as const;
export type OvertimeMode = (typeof OVERTIME_MODES)[number];

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
    /**
     * ⭐ **T-197 / DEF-112 — default TRUE, because the business already runs it that way.**
     *
     * The raw v1 capture (no default merge) shows all three operating stores — Lipa, Malvar,
     * Banay-Banay — carrying `true`, against a v1 default of `false`. Each turned it on
     * deliberately. v2 shipping `false` did not preserve the status quo, it reversed it: measured
     * on the 560-session live corpus, 51.5 days a month, ~9.2% of basic pay.
     *
     * ⚠️ The default is load-bearing here in a way it usually is not: v2 assumes a zero starting
     * point, so every store is created fresh and `seedAttendanceConfig` inserts with no explicit
     * values. A store that wants it off supersedes its config.
     */
    shortShiftHalfDayOt: boolean('short_shift_half_day_ot').notNull().default(true),
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
    /**
     * ⭐ T-157b. How far a clock-in may be from an allowed hour and still count as aiming for it.
     * On a full hourly grid this can never fire — 30 is the maximum possible distance when every
     * hour is allowed, confirmed across 550 real sessions. It catches a SPARSE or STALE grid.
     */
    anchorWindowMinutes: integer('anchor_window_minutes').notNull().default(30),
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

    /**
     * ⭐ T-189b. Ian, 2026-08-31: *"for OT it must be configurable to x1.25 or fix amount."*
     *
     * `multiplier` prices an overtime hour as the hourly equivalent of the daily rate times
     * `overtimeMultiplier`. `fixed` REPLACES that with a flat peso amount per overtime hour — it is
     * not a multiplier on anything, which is why it is a separate mode rather than a second number
     * quietly reinterpreted.
     */
    overtimeMode: text('overtime_mode', { enum: OVERTIME_MODES }).notNull().default('multiplier'),
    /** ⚠️ Pesos per overtime HOUR. Required when the mode is `fixed`, by CHECK — a store that says
     *  it pays a flat amount and does not say what it is would price every OT hour at zero. */
    overtimeFixedHourly: numeric('overtime_fixed_hourly', { precision: 14, scale: 2 }),

    /**
     * ⭐ T-189b. Ian: *"holiday must be configurable too. 1.3, 1.5, 2."*
     *
     * THREE, not one, because `attendance_days.holidayType` already records which kind of holiday
     * a day was. A single number would price a regular holiday the same as a special one and throw
     * that distinction away. ⚠️ v1 hardcodes 2.0 / 1.3 and has no third at all.
     */
    holidayRegularMultiplier: numeric('holiday_regular_multiplier', { precision: 4, scale: 2 })
      .notNull()
      .default('2.00'),
    holidaySpecialNonWorkingMultiplier: numeric('holiday_special_non_working_multiplier', {
      precision: 4,
      scale: 2,
    })
      .notNull()
      .default('1.30'),
    holidaySpecialWorkingMultiplier: numeric('holiday_special_working_multiplier', {
      precision: 4,
      scale: 2,
    })
      .notNull()
      .default('1.50'),

    /**
     * ⭐ T-189c. How this store's pay periods are cut. Ian: *"look how payroll dates are
     * configured in v1, it must be configurable."*
     */
    payrollPeriodType: text('payroll_period_type', { enum: PAYROLL_PERIOD_TYPES })
      .notNull()
      .default('semi_monthly'),

    /**
     * The day the FIRST semi-monthly period ends; the second runs to month end.
     *
     * ⚠️ **ONE number, where v1 stores a pair.** v1's `semiMonthlyCutoffs` is `[number, number]`
     * and `derivePeriods` only ever reads `[0]` — the second period always ends on the last day of
     * the month, computed. The stored second element is dead weight that can disagree with reality
     * (a 31 sitting in the config in February).
     */
    semiMonthlyCutoffDay: integer('semi_monthly_cutoff_day').notNull().default(15),

    /**
     * ⭐ T-189d. How payday is decided.
     *
     * `lag` is v1's model — N days after the period ends. `fixed_days` is the more common
     * Philippine one, and the one a lag **cannot express**: paid on the 10th and the 25th, where
     * the gap from the period end is a different number of days every month.
     */
    payoutMode: text('payout_mode', { enum: PAYOUT_MODES }).notNull().default('lag'),

    /** Days after a period ends before the money is handed over. v1's `payoutLagDays`. */
    payoutLagDays: integer('payout_lag_days').notNull().default(0),

    /**
     * One day-of-month per period, in period order. ⚠️ Shorter than the period count is legal —
     * the LAST entry then applies to the rest, which is what a store paying weekly on a Friday
     * actually means.
     *
     * ⭐ An integer ARRAY for the same reason `allowedShiftStartHours` is: a set of small integers
     * has no fields, no identity and no lifecycle, so a child table would mint a uuid in order to
     * store the number 10. NOT a map-as-record.
     */
    payoutDays: integer('payout_days')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),

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
    /**
     * ⭐ **T-199.** The wall-clock hour at which every still-open day is cleared, *"so the floor is
     * empty before the store opens"* (Ian, via v1). Live at all three v1 stores: **02:00**.
     *
     * ⛔ **Nullable, defaulting to null** — "this store never auto-clears" is where every store is
     * today, and DEF-087's lesson is that an unset value must not masquerade as a chosen one.
     * ⚠️ v1 needs a runtime guard here because `Number('')` is `0` — midnight, the one hour a floor
     * is most likely to still have people on it. An integer column plus null makes that
     * unrepresentable rather than merely guarded.
     */
    autoClockOutHour: integer('auto_clock_out_hour'),
    /** ⭐ The per-day backstop: open longer than this was clearly forgotten. A BACKSTOP, not a
     *  second policy on hours — which is why the CHECK floors it at 10 rather than at the shift. */
    maxShiftHours: integer('max_shift_hours').notNull().default(16),
    breakEnabled: boolean('break_enabled').notNull().default(true),
    /**
     * ⭐ The per-method kill switches — bible §5.3 **hot-set item 3**, and explicitly *"a NEW cache
     * addition, not a port"*. Landmine #15: v1 does not cache these offline, so a terminal keeps
     * accepting a method an admin has just disabled and the rejection surfaces only at sync time,
     * as a silent dead letter. Caching them is a bug fix.
     *
     * ⛔ **There is no `credentialPasscode`.** D1, 2026-08-29: the PIN is not a mode of attendance in
     * v2, so it has no switch — a column that can only ever hold one value is a question nobody
     * should be asked (migration 0085).
     */
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
    check('store_attendance_config_overtime_mode_check', sql`${t.overtimeMode} in ('multiplier', 'fixed')`),
    check(
      'store_attendance_config_period_type_check',
      sql`${t.payrollPeriodType} in ('monthly', 'semi_monthly', 'weekly')`,
    ),
    /** ⛔ 1..27, not 1..31: 28 or later makes February's second period empty or inverted. v1
     *  clamps at READ time, so a store there can hold a value its own code ignores. */
    check(
      'store_attendance_config_cutoff_day_check',
      sql`${t.semiMonthlyCutoffDay} between 1 and 27`,
    ),
    check('store_attendance_config_payout_lag_check', sql`${t.payoutLagDays} between 0 and 31`),
    check('store_attendance_config_payout_mode_check', sql`${t.payoutMode} in ('lag', 'fixed_days')`),
    /** ⛔ A store that says it pays on fixed days must say WHICH, or payday would fall back to
     *  the period end without anybody noticing. */
    check(
      'store_attendance_config_fixed_days_needed_check',
      sql`${t.payoutMode} = 'lag' or cardinality(${t.payoutDays}) > 0`,
    ),
    /** ⭐ The dangerous combination is unrepresentable — the same shape T-152 used for the
     *  un-remitted ceiling. A store on `fixed` with no amount would price every OT hour at zero. */
    check(
      'store_attendance_config_fixed_ot_needs_amount_check',
      sql`${t.overtimeMode} = 'multiplier' or ${t.overtimeFixedHourly} is not null`,
    ),
    check(
      'store_attendance_config_fixed_ot_positive_check',
      sql`${t.overtimeFixedHourly} is null or ${t.overtimeFixedHourly} > 0`,
    ),
    /** ⛔ Below 1 would turn a holiday premium into a deduction — the premium is an ADD-ON. */
    check(
      'store_attendance_config_holiday_multipliers_check',
      sql`${t.holidayRegularMultiplier} >= 1 and ${t.holidaySpecialNonWorkingMultiplier} >= 1
          and ${t.holidaySpecialWorkingMultiplier} >= 1`,
    ),
    check('store_attendance_config_anchor_window_check', sql`${t.anchorWindowMinutes} >= 0 and ${t.anchorWindowMinutes} <= 60`),
    check(
      'store_attendance_config_grace_non_negative_check',
      sql`${t.lateGraceMinutes} >= 0 and ${t.earlyOutGraceMinutes} >= 0 and ${t.undertimeGraceMinutes} >= 0`,
    ),
    // NOTE: the allowed-hours normalisation (non-empty, all within 0..23, sorted and distinct as
    // stored) is an array CHECK that Drizzle's builder cannot express; it is hand-added in the
    // migration, the same way `person_identities` documents its own expression index.
  ],
);
