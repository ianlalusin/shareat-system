/**
 * Statutory reference tables - T-190, migration 0206. `docs/tasks/190-payroll-statutory.md`.
 *
 * Three per-org tables hold every figure payroll uses for SSS, PhilHealth, Pag-IBIG, withholding tax and the minimum wage.
 * ⛔ No rate lives in code: a payslip reads the row in force on its run's `period_end`, and stores the row id it used.
 *
 * ⛔ IMMUTABLE. A row is never edited. The app role holds UPDATE on `confirmed_at` / `confirmed_by` only, and a trigger
 * (hand-added in migration 0206, `t190_reference_row_immutable`) refuses any other change and a second confirmation. A
 * confirmed row cannot be deleted. A correction is a NEW row with a later `effective_from`.
 *
 * NOTE: the triggers, the column-level GRANTs, the RLS policies and the statutory_rates day-of-month CHECK
 * (`effective_from` must be the 1st) are hand-added in migration 0206; Drizzle has no builder for them.
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const STATUTORY_AGENCIES = ['sss', 'philhealth', 'pagibig'] as const;
export type StatutoryAgency = (typeof STATUTORY_AGENCIES)[number];
export const CONTRIBUTION_BASE_KINDS = ['gross', 'basic'] as const;
export type ContributionBaseKind = (typeof CONTRIBUTION_BASE_KINDS)[number];
export const WITHHOLDING_FREQUENCIES = ['monthly', 'semi_monthly', 'weekly'] as const;
export type WithholdingFrequency = (typeof WITHHOLDING_FREQUENCIES)[number];

export const statutoryRates = pgTable(
  'statutory_rates',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    agency: text('agency', { enum: STATUTORY_AGENCIES }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    eeRate: numeric('ee_rate', { precision: 14, scale: 4 }).notNull(),
    erRate: numeric('er_rate', { precision: 14, scale: 4 }).notNull(),
    baseKind: text('base_kind', { enum: CONTRIBUTION_BASE_KINDS }).notNull(),
    floor: numeric('floor', { precision: 14, scale: 2 }),
    ceiling: numeric('ceiling', { precision: 14, scale: 2 }),
    /** SSS: the compensation bracket step (₱500). */
    step: numeric('step', { precision: 14, scale: 2 }),
    /** Pag-IBIG: at or under this monthly compensation the employee rate is `lowEeRate`. */
    lowThreshold: numeric('low_threshold', { precision: 14, scale: 2 }),
    lowEeRate: numeric('low_ee_rate', { precision: 14, scale: 4 }),
    /** SSS EC (employer only): `ecLow` when the MSC is under `ecThreshold`, else `ecHigh`. */
    ecThreshold: numeric('ec_threshold', { precision: 14, scale: 2 }),
    ecLow: numeric('ec_low', { precision: 14, scale: 2 }),
    ecHigh: numeric('ec_high', { precision: 14, scale: 2 }),
    sourceRef: text('source_ref').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('statutory_rates_org_agency_from_unique').on(t.orgId, t.agency, t.effectiveFrom),
    check('statutory_rates_ee_rate_finite_check', sql`${t.eeRate} > '-Infinity'::numeric and ${t.eeRate} < 'Infinity'::numeric`),
    check('statutory_rates_er_rate_finite_check', sql`${t.erRate} > '-Infinity'::numeric and ${t.erRate} < 'Infinity'::numeric`),
    check('statutory_rates_floor_finite_check', sql`${t.floor} > '-Infinity'::numeric and ${t.floor} < 'Infinity'::numeric`),
    check('statutory_rates_ceiling_finite_check', sql`${t.ceiling} > '-Infinity'::numeric and ${t.ceiling} < 'Infinity'::numeric`),
    check('statutory_rates_step_finite_check', sql`${t.step} > '-Infinity'::numeric and ${t.step} < 'Infinity'::numeric`),
    check('statutory_rates_low_threshold_finite_check', sql`${t.lowThreshold} > '-Infinity'::numeric and ${t.lowThreshold} < 'Infinity'::numeric`),
    check('statutory_rates_low_ee_rate_finite_check', sql`${t.lowEeRate} > '-Infinity'::numeric and ${t.lowEeRate} < 'Infinity'::numeric`),
    check('statutory_rates_ec_threshold_finite_check', sql`${t.ecThreshold} > '-Infinity'::numeric and ${t.ecThreshold} < 'Infinity'::numeric`),
    check('statutory_rates_ec_low_finite_check', sql`${t.ecLow} > '-Infinity'::numeric and ${t.ecLow} < 'Infinity'::numeric`),
    check('statutory_rates_ec_high_finite_check', sql`${t.ecHigh} > '-Infinity'::numeric and ${t.ecHigh} < 'Infinity'::numeric`),
    check('statutory_rates_agency_check', sql`${t.agency} in ('sss', 'philhealth', 'pagibig')`),
    check('statutory_rates_base_kind_check', sql`${t.baseKind} in ('gross', 'basic')`),
    check('statutory_rates_confirmed_pair_check', sql`(${t.confirmedAt} is null) = (${t.confirmedBy} is null)`),
    foreignKey({
      columns: [t.orgId, t.confirmedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'statutory_rates_confirmed_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const withholdingBrackets = pgTable(
  'withholding_brackets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    frequency: text('frequency', { enum: WITHHOLDING_FREQUENCIES }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    /** Tax = baseTax + rate x (taxable - over), for the last row whose `over` is below the taxable pay. */
    over: numeric('over', { precision: 14, scale: 2 }).notNull(),
    baseTax: numeric('base_tax', { precision: 14, scale: 2 }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 4 }).notNull(),
    sourceRef: text('source_ref').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('withholding_brackets_org_freq_from_over_unique').on(t.orgId, t.frequency, t.effectiveFrom, t.over),
    check('withholding_brackets_over_finite_check', sql`${t.over} > '-Infinity'::numeric and ${t.over} < 'Infinity'::numeric`),
    check('withholding_brackets_base_tax_finite_check', sql`${t.baseTax} > '-Infinity'::numeric and ${t.baseTax} < 'Infinity'::numeric`),
    check('withholding_brackets_rate_finite_check', sql`${t.rate} > '-Infinity'::numeric and ${t.rate} < 'Infinity'::numeric`),
    check('withholding_brackets_frequency_check', sql`${t.frequency} in ('monthly', 'semi_monthly', 'weekly')`),
    check('withholding_brackets_confirmed_pair_check', sql`(${t.confirmedAt} is null) = (${t.confirmedBy} is null)`),
    foreignKey({
      columns: [t.orgId, t.confirmedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'withholding_brackets_confirmed_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const minimumWages = pgTable(
  'minimum_wages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    effectiveFrom: date('effective_from').notNull(),
    dailyRate: numeric('daily_rate', { precision: 14, scale: 2 }).notNull(),
    wageOrderRef: text('wage_order_ref').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('minimum_wages_org_store_from_unique').on(t.orgId, t.storeId, t.effectiveFrom),
    check('minimum_wages_daily_rate_finite_check', sql`${t.dailyRate} > '-Infinity'::numeric and ${t.dailyRate} < 'Infinity'::numeric`),
    check('minimum_wages_confirmed_pair_check', sql`(${t.confirmedAt} is null) = (${t.confirmedBy} is null)`),
    check('minimum_wages_daily_rate_check', sql`${t.dailyRate} > 0`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'minimum_wages_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.confirmedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'minimum_wages_confirmed_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
