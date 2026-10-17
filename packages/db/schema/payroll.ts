/**
 * Payroll — the rate, the run, and the payslip. T-189, Phase 5 slice 1.
 * `docs/tasks/189-pay-rates-and-the-pay-run.md`, `docs/plans/phase-5-payroll.md`.
 *
 * ## ⛔ What the live data said before any of this was designed
 *
 * v1's payroll is three shipped slices, ~4,200 lines, a verified PH-2024 tax engine and a GL
 * posting path. **It has produced zero payslips.** `payrollRuns` does not exist as a collection on
 * any of the seven stores. And **not one of 126 staff has an SSS, PhilHealth, Pag-IBIG or TIN
 * number** — so the bracket engine has no fuel at all.
 *
 * ⭐ So this is not a port. It is the smallest thing that actually pays somebody: a rate, a run
 * that computes from `attendance_days`, nets what the person already drew against `1230`, posts,
 * and freezes the days it paid. Statutory follows the data (phase plan §5), not the other way.
 *
 * ## ⭐ This is what the attendance lane left the seam for
 *
 * `attendance_days.frozenByPayRunId` has existed since T-157 with its FK deliberately absent —
 * *"the column lands now; Phase 5 sets it, which is why the FK is deliberately absent until the
 * pay-run table exists."* Migration `0105` attaches it.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { statutoryRates } from './statutory';
import { stores } from './stores';

/**
 * ⚠️ Only `daily` has a compute path, and that is a measurement, not an oversight: of 126 live v1
 * staff, **51 have a `payType` and every one of them is `daily`** — exactly ONE carries an hourly
 * rate. `hourly` is stored so the day someone is genuinely paid that way the rate is already
 * representable; writing the compute path now would be writing for nobody.
 */
export const PAY_BASES = ['daily', 'hourly'] as const;
export type PayBasis = (typeof PAY_BASES)[number];

export const PAY_RUN_STATUSES = ['draft', 'posted', 'voided'] as const;
export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];

// -------------------------------------------------------------------------------------

/**
 * What a job pays, from a date.
 *
 * ⛔ **APPEND-ONLY, and there is no `effective_to`.** v1 maintains one — `hourlyRateHistory` closes
 * the open row when a new rate is written — and a stored end date is a second fact that can
 * disagree with the next row's start. Here the rate in force on a date is *the latest row whose
 * `effectiveFrom <= date`*. One fact, no closing write, nothing to drift.
 *
 * ⛔ A wrong rate is SUPERSEDED by a new row, never updated: a payslip already posted was computed
 * under the old one and has to stay explicable.
 */
export const payRates = pgTable(
  'pay_rates',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /** ⭐ A rate belongs to a JOB, not a person — a rehire is a new employment with a new rate. */
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),

    basis: text('basis', { enum: PAY_BASES }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),

    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One rate per job per day it changes. A second row for the same day is two answers. */
    uniqueIndex('pay_rates_employment_from_unique').on(t.employmentId, t.effectiveFrom),
    index('pay_rates_org_idx').on(t.orgId),
    check('pay_rates_amount_positive_check', sql`${t.amount} > 0`),
    check('pay_rates_basis_check', sql`${t.basis} in ('daily', 'hourly')`),
    check('pay_rates_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pay_rates_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * A period paid, for one store.
 *
 * ⭐ **The overlap guard is an EXCLUDE constraint, not a unique index** — bible §16.6 names this
 * exactly: *"a paid payroll period is frozen, blocked by period OVERLAP not exact bounds — the
 * stricter and correct test."* A unique index on `(store, start, end)` would happily accept
 * 1–15 August beside 10–20 August and pay the overlap twice. Written in migration `0105`, because
 * Drizzle has no builder for `EXCLUDE USING gist`.
 */
export const payRuns = pgTable(
  'pay_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),

    status: text('status', { enum: PAY_RUN_STATUSES }).notNull().default('draft'),

    /** Where the net is paid from. ⚠️ Runs through the ordinary overdraft guard — payroll is not
     *  exempt from "can this account actually cover it". */
    moneyAccountId: uuid('money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),

    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),

    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // T-436 (migration 0205): the target of the leave tables' same-org composite FKs on frozen_by_pay_run_id.
    unique('pay_runs_org_id_id_unique').on(t.orgId, t.id),
    index('pay_runs_org_status_idx').on(t.orgId, t.status),
    index('pay_runs_store_period_idx').on(t.storeId, t.periodStart, t.periodEnd),
    check('pay_runs_period_order_check', sql`${t.periodEnd} >= ${t.periodStart}`),
    check('pay_runs_status_check', sql`${t.status} in ('draft', 'posted', 'voided')`),
    /** ⚠️ `posted_at` / `posted_by` SURVIVE a void — a voided run WAS posted, and erasing when and
     *  by whom would erase the only record that it ever paid anybody. So the shape check is about
     *  DRAFT, not about `posted`. */
    check('pay_runs_posted_pair_check', sql`(${t.postedAt} is null) = (${t.postedBy} is null)`),
    check('pay_runs_posted_shape_check', sql`(${t.status} = 'draft') = (${t.postedAt} is null)`),
    check(
      'pay_runs_void_shape_check',
      sql`(${t.status} = 'voided') = (${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    // T-357 / DEF-490, migration 0171 — the single-column FK above accepts a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). References
    // `money_accounts_org_id_id_unique` (`schema/money-accounts.ts` — hand-added in migration
    // 0171).
    foreignKey({
      columns: [t.orgId, t.moneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'pay_runs_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pay_runs_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.postedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pay_runs_posted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'pay_runs_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pay_runs_voided_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * One person's pay for one run.
 *
 * ⚠️ **The identity is a CHECK, not a comment.** v1's balance identity grew from four legs to five
 * to six over three weeks, and each time *"anything asserting the five-leg identity breaks."*
 * Writing it into the schema means the migration that adds statutory must also restate the rule —
 * once, deliberately, in the place that enforces it.
 */
export const payslips = pgTable(
  'payslips',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => payRuns.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),
    /** ⚠️ Stored as well as the employment: an employment can end, and a payslip has to stay
     *  readable years later without walking a chain that may have been closed. */
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    /** ⭐ The rate this was computed under. Same historical-integrity pattern as
     *  `attendance_days.attendanceConfigId` — re-reading a March payslip in June gives March's
     *  answer, even after a raise. */
    payRateId: uuid('pay_rate_id')
      .notNull()
      .references(() => payRates.id, { onDelete: 'restrict' }),

    daysWorked: numeric('days_worked', { precision: 6, scale: 2 }).notNull(),
    minutesWorked: integer('minutes_worked').notNull().default(0),
    otMinutes: integer('ot_minutes').notNull().default(0),
    nightDiffMinutes: integer('night_diff_minutes').notNull().default(0),
    holidayMinutes: integer('holiday_minutes').notNull().default(0),

    basicPay: numeric('basic_pay', { precision: 14, scale: 2 }).notNull(),
    otPay: numeric('ot_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    nightDiffPay: numeric('night_diff_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    holidayPay: numeric('holiday_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    /** T-436 (migration 0205). Paid leave days priced at the daily rate in force that day. ⛔ NEVER part of `basic_pay`: the 13th month reads it. */
    leavePay: numeric('leave_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    /** T-436. The year-end / final-pay cash payout of unused Service Incentive Leave. ⛔ Not in `basic_pay` either (PD 851). */
    silConversionPay: numeric('sil_conversion_pay', { precision: 14, scale: 2 }).notNull().default('0'),

    grossPay: numeric('gross_pay', { precision: 14, scale: 2 }).notNull(),
    /** ⛔ Capped at gross. Net may reach zero; it may never go below, and what is still owed stays
     *  owed on `1230`. */
    advanceRecovered: numeric('advance_recovered', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    netPay: numeric('net_pay', { precision: 14, scale: 2 }).notNull(),

    // ---- T-190 (migration 0206). The employee share is deducted from the pay, the employer share is a cost on top.
    sssEe: numeric('sss_ee', { precision: 14, scale: 2 }).notNull().default('0'),
    philhealthEe: numeric('philhealth_ee', { precision: 14, scale: 2 }).notNull().default('0'),
    pagibigEe: numeric('pagibig_ee', { precision: 14, scale: 2 }).notNull().default('0'),
    withholding: numeric('withholding', { precision: 14, scale: 2 }).notNull().default('0'),
    sssEr: numeric('sss_er', { precision: 14, scale: 2 }).notNull().default('0'),
    sssEc: numeric('sss_ec', { precision: 14, scale: 2 }).notNull().default('0'),
    philhealthEr: numeric('philhealth_er', { precision: 14, scale: 2 }).notNull().default('0'),
    pagibigEr: numeric('pagibig_er', { precision: 14, scale: 2 }).notNull().default('0'),
    taxablePay: numeric('taxable_pay', { precision: 14, scale: 2 }).notNull().default('0'),
    isMwe: boolean('is_mwe').notNull().default(false),
    /** Agencies NOT deducted because the person had no number on file when this slip was posted. */
    skippedAgencies: text('skipped_agencies').array().notNull().default(sql`'{}'::text[]`),
    /** ⭐ The rate rows used (the "re-read March in June" rule, as `pay_rate_id`); null where the agency was skipped. */
    sssRateId: uuid('sss_rate_id').references(() => statutoryRates.id, { onDelete: 'restrict' }),
    philhealthRateId: uuid('philhealth_rate_id').references(() => statutoryRates.id, { onDelete: 'restrict' }),
    pagibigRateId: uuid('pagibig_rate_id').references(() => statutoryRates.id, { onDelete: 'restrict' }),

    journalEntryId: uuid('journal_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One payslip per job per run. Two would pay the period twice. */
    uniqueIndex('payslips_run_employment_unique').on(t.runId, t.employmentId),
    index('payslips_org_person_idx').on(t.orgId, t.personId),
    index('payslips_run_idx').on(t.runId),

    check('payslips_days_nonnegative_check', sql`${t.daysWorked} >= 0`),
    check(
      'payslips_gross_identity_check',
      // T-436 (migration 0205) restated it with the two new legs, as this comment demanded of whoever adds one.
      sql`${t.grossPay} = ${t.basicPay} + ${t.otPay} + ${t.nightDiffPay} + ${t.holidayPay} + ${t.leavePay} + ${t.silConversionPay}`,
    ),
    /** ⭐ Restated by migration 0206 (T-190): net = gross - the three employee shares - withholding - advance. */
    check(
      'payslips_net_identity_check',
      sql`${t.netPay} = ${t.grossPay} - ${t.sssEe} - ${t.philhealthEe} - ${t.pagibigEe} - ${t.withholding} - ${t.advanceRecovered}`,
    ),
    check('payslips_net_nonnegative_check', sql`${t.netPay} >= 0`),
    check(
      'payslips_advance_within_gross_check',
      sql`${t.advanceRecovered} <= ${t.grossPay} - ${t.sssEe} - ${t.philhealthEe} - ${t.pagibigEe} - ${t.withholding}`,
    ),
    check('payslips_skipped_agencies_check', sql`${t.skippedAgencies} <@ ARRAY['sss', 'philhealth', 'pagibig']::text[]`),
    check(
      'payslips_statutory_nonnegative_check',
      sql`${t.sssEe} >= 0 and ${t.philhealthEe} >= 0 and ${t.pagibigEe} >= 0 and ${t.withholding} >= 0 and ${t.sssEr} >= 0 and ${t.sssEc} >= 0 and ${t.philhealthEr} >= 0 and ${t.pagibigEr} >= 0 and ${t.taxablePay} >= 0`,
    ),
    check('payslips_sss_ee_finite_check', sql`${t.sssEe} > '-Infinity'::numeric and ${t.sssEe} < 'Infinity'::numeric`),
    check('payslips_philhealth_ee_finite_check', sql`${t.philhealthEe} > '-Infinity'::numeric and ${t.philhealthEe} < 'Infinity'::numeric`),
    check('payslips_pagibig_ee_finite_check', sql`${t.pagibigEe} > '-Infinity'::numeric and ${t.pagibigEe} < 'Infinity'::numeric`),
    check('payslips_withholding_finite_check', sql`${t.withholding} > '-Infinity'::numeric and ${t.withholding} < 'Infinity'::numeric`),
    check('payslips_sss_er_finite_check', sql`${t.sssEr} > '-Infinity'::numeric and ${t.sssEr} < 'Infinity'::numeric`),
    check('payslips_sss_ec_finite_check', sql`${t.sssEc} > '-Infinity'::numeric and ${t.sssEc} < 'Infinity'::numeric`),
    check('payslips_philhealth_er_finite_check', sql`${t.philhealthEr} > '-Infinity'::numeric and ${t.philhealthEr} < 'Infinity'::numeric`),
    check('payslips_pagibig_er_finite_check', sql`${t.pagibigEr} > '-Infinity'::numeric and ${t.pagibigEr} < 'Infinity'::numeric`),
    check('payslips_taxable_pay_finite_check', sql`${t.taxablePay} > '-Infinity'::numeric and ${t.taxablePay} < 'Infinity'::numeric`),
    check('payslips_days_worked_finite_check', sql`${t.daysWorked} > '-Infinity'::numeric and ${t.daysWorked} < 'Infinity'::numeric`),
    check('payslips_basic_pay_finite_check', sql`${t.basicPay} > '-Infinity'::numeric and ${t.basicPay} < 'Infinity'::numeric`),
    check('payslips_ot_pay_finite_check', sql`${t.otPay} > '-Infinity'::numeric and ${t.otPay} < 'Infinity'::numeric`),
    check('payslips_night_diff_pay_finite_check', sql`${t.nightDiffPay} > '-Infinity'::numeric and ${t.nightDiffPay} < 'Infinity'::numeric`),
    check('payslips_holiday_pay_finite_check', sql`${t.holidayPay} > '-Infinity'::numeric and ${t.holidayPay} < 'Infinity'::numeric`),
    check('payslips_leave_pay_finite_check', sql`${t.leavePay} > '-Infinity'::numeric and ${t.leavePay} < 'Infinity'::numeric`),
    check('payslips_sil_conversion_pay_finite_check', sql`${t.silConversionPay} > '-Infinity'::numeric and ${t.silConversionPay} < 'Infinity'::numeric`),
    check('payslips_leave_legs_nonnegative_check', sql`${t.leavePay} >= 0 and ${t.silConversionPay} >= 0`),
    check('payslips_gross_pay_finite_check', sql`${t.grossPay} > '-Infinity'::numeric and ${t.grossPay} < 'Infinity'::numeric`),
    check('payslips_advance_recovered_finite_check', sql`${t.advanceRecovered} > '-Infinity'::numeric and ${t.advanceRecovered} < 'Infinity'::numeric`),
    check('payslips_net_pay_finite_check', sql`${t.netPay} > '-Infinity'::numeric and ${t.netPay} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'payslips_person_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
