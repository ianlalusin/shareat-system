/**
 * Leave and absence tracking - kinds, caps, requests, per-date days, the year-end SIL payout. T-436.
 * `docs/tasks/436-leave-tracking.md`, migration 0205 (hand-authored, ADR-012 s5).
 *
 * ## The scope is the PERSON, not the employment
 *
 * Service start, the Service Incentive Leave balance, the caps and "one leave day per date" all belong to the PERSON in the
 * org: a person with two concurrent jobs, or one who transferred stores, keeps one balance and one service date. The
 * employment is recorded on the request only to say WHICH job (and so which store and which pay rate) it was filed under.
 *
 * ## Kinds are referenced by CODE, not by foreign key
 *
 * `leave_types.org_id` is NULL for the platform seed every org sees, so a same-org composite FK (T-398) cannot point at it.
 * Requests, days and caps carry the kind's code and the domain validates it.
 *
 * ## Personal data (bible row 353)
 *
 * `leave_requests.note` is a reason or a medical note. The domain loader returns it only to the person and to a
 * `manage_attendance` holder at the filing store; no list, grid, export or audit payload selects it.
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
import { employments, positions } from './employment';
import { organizations } from './organizations';
import { payRuns } from './payroll';
import { persons } from './persons';
import { separations } from './separations';
import { stores } from './stores';

export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'voided'] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

/** A day's own status mirrors its request's, plus `superseded_by_work` (punches arrived on an approved, unpaid leave date). */
export const LEAVE_DAY_STATUSES = [...LEAVE_REQUEST_STATUSES, 'superseded_by_work'] as const;
export type LeaveDayStatus = (typeof LEAVE_DAY_STATUSES)[number];

export const LEAVE_DAY_KINDS = ['leave', 'rest_day'] as const;
export type LeaveDayKind = (typeof LEAVE_DAY_KINDS)[number];

export const LEAVE_ORIGINS = ['request', 'record'] as const;
export type LeaveOrigin = (typeof LEAVE_ORIGINS)[number];

// -------------------------------------------------------------------------------------

export const leaveTypes = pgTable(
  'leave_types',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /**
     * NULL = the platform seed (the eleven kinds). An org-owned row is a kind that org added.
     * ⚠️ No FK to `organizations`, on purpose (migration 0205): `TRUNCATE organizations CASCADE` would wipe the seed through it.
     */
    orgId: uuid('org_id'),
    code: text('code').notNull(),
    label: text('label').notNull(),
    /** The default pay mode. A manager may approve a draws-SIL kind as paid or unpaid; see `drawsSil`. */
    paid: boolean('paid').notNull(),
    /** A paid day of this kind uses one of the person's 5 Service Incentive Leave days. */
    drawsSil: boolean('draws_sil').notNull().default(false),
    statutory: boolean('statutory').notNull().default(false),
    needsProof: boolean('needs_proof').notNull().default(false),
    requestable: boolean('requestable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    /** The legal yearly day limit (solo parent 7, VAWC 10, special women 60). A cap may raise it, never lower it. */
    legalYearlyDays: integer('legal_yearly_days'),
    /** The legal limit PER BIRTH (maternity 105, paternity 7): checked against the request's birth date, never against caps. */
    legalPerBirthDays: integer('legal_per_birth_days'),
    /** Paternity: the first 4 deliveries. */
    legalMaxBirths: integer('legal_max_births'),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NOTE: `UNIQUE NULLS NOT DISTINCT (org_id, code)` (`leave_types_org_code_unique`), the three RLS policies and the
    // platform seed are hand-added in migration 0205 (ADR-012 s5 item 3).
    check('leave_types_code_shape_check', sql`${t.code} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check(
      'leave_types_legal_days_positive_check',
      sql`(${t.legalYearlyDays} is null or ${t.legalYearlyDays} > 0)
          and (${t.legalPerBirthDays} is null or ${t.legalPerBirthDays} > 0)
          and (${t.legalMaxBirths} is null or ${t.legalMaxBirths} > 0)`,
    ),
  ],
);

// -------------------------------------------------------------------------------------

export const leaveCaps = pgTable(
  'leave_caps',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    leaveType: text('leave_type').notNull(),
    /** NULL store + NULL position = the org default. Most specific row wins: store+position > position > store > org. */
    storeId: uuid('store_id'),
    positionId: uuid('position_id'),
    /** NULL = no limit. */
    monthlyCap: integer('monthly_cap'),
    yearlyCap: integer('yearly_cap'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // NOTE: `leave_caps_scope_unique` is `UNIQUE NULLS NOT DISTINCT (org_id, leave_type, store_id, position_id)`, hand-added in
    // migration 0205 - Drizzle has no builder for NULLS NOT DISTINCT on a table constraint here.
    check(
      'leave_caps_nonnegative_check',
      sql`(${t.monthlyCap} is null or ${t.monthlyCap} >= 0) and (${t.yearlyCap} is null or ${t.yearlyCap} >= 0)`,
    ),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'leave_caps_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.positionId], foreignColumns: [positions.orgId, positions.id], name: 'leave_caps_position_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [persons.orgId, persons.id], name: 'leave_caps_created_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [persons.orgId, persons.id], name: 'leave_caps_updated_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------

export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    personId: uuid('person_id').notNull(),
    /** The job it was filed under: decides the filing store, the pay rate and the cap overrides. */
    employmentId: uuid('employment_id').notNull(),
    storeId: uuid('store_id').notNull(),
    leaveType: text('leave_type').notNull(),
    status: text('status', { enum: LEAVE_REQUEST_STATUSES }).notNull(),
    /** `request`: the person (or a manager for them) asked and a manager decides. `record`: a manager entered a past absence, approved at once. */
    origin: text('origin', { enum: LEAVE_ORIGINS }).notNull(),
    /** Decided with the approval; NULL while pending. */
    paid: boolean('paid'),
    /** Maternity and paternity only: the birth the days belong to (the limits are per birth). */
    birthDate: date('birth_date'),
    /** ⛔ PERSONAL DATA (bible row 353). Never selected by a list, grid, export or audit payload. */
    note: text('note'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    voidedBy: uuid('voided_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
  },
  (t) => [
    unique('leave_requests_org_id_id_unique').on(t.orgId, t.id),
    index('leave_requests_person_idx').on(t.personId, t.status),
    index('leave_requests_store_status_idx').on(t.storeId, t.status),
    check('leave_requests_status_check', sql`${t.status} in ('pending','approved','rejected','cancelled','voided')`),
    check('leave_requests_origin_check', sql`${t.origin} in ('request','record')`),
    check('leave_requests_decided_pair_check', sql`(${t.decidedBy} is null) = (${t.decidedAt} is null)`),
    check('leave_requests_decided_shape_check', sql`(${t.status} in ('approved','rejected','voided')) = (${t.decidedBy} is not null)`),
    check(
      'leave_requests_void_shape_check',
      sql`(${t.status} = 'voided') = (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)`,
    ),
    check('leave_requests_cancel_shape_check', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
    foreignKey({ columns: [t.orgId, t.personId], foreignColumns: [persons.orgId, persons.id], name: 'leave_requests_person_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.employmentId], foreignColumns: [employments.orgId, employments.id], name: 'leave_requests_employment_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'leave_requests_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.requestedBy], foreignColumns: [persons.orgId, persons.id], name: 'leave_requests_requested_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.decidedBy], foreignColumns: [persons.orgId, persons.id], name: 'leave_requests_decided_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.voidedBy], foreignColumns: [persons.orgId, persons.id], name: 'leave_requests_voided_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------

export const leaveRequestDays = pgTable(
  'leave_request_days',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id').notNull(),
    personId: uuid('person_id').notNull(),
    employmentId: uuid('employment_id').notNull(),
    storeId: uuid('store_id').notNull(),
    /** A copy of the request's kind code, immutable, so a cap count is one indexed read. */
    leaveType: text('leave_type').notNull(),
    leaveDate: date('leave_date').notNull(),
    /** `rest_day` rows are not paid, use no SIL and count toward no cap. */
    kind: text('kind', { enum: LEAVE_DAY_KINDS }).notNull(),
    status: text('status', { enum: LEAVE_DAY_STATUSES }).notNull(),
    paid: boolean('paid').notNull().default(false),
    /** Same pair, same CHECK and same release-on-void as `attendance_days` (0105): a day paid by a run is frozen to it. */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    frozenByPayRunId: uuid('frozen_by_pay_run_id').references(() => payRuns.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // ⛔ One LIVE (pending or approved) leave day per PERSON per date, whichever job or store it was filed under.
    uniqueIndex('leave_request_days_live_person_date_unique')
      .on(t.personId, t.leaveDate)
      .where(sql`${t.status} in ('pending','approved')`),
    index('leave_request_days_request_idx').on(t.requestId),
    index('leave_request_days_store_date_idx').on(t.storeId, t.leaveDate),
    index('leave_request_days_frozen_run_idx')
      .on(t.frozenByPayRunId)
      .where(sql`${t.frozenByPayRunId} is not null`),
    check('leave_request_days_kind_check', sql`${t.kind} in ('leave','rest_day')`),
    check(
      'leave_request_days_status_check',
      sql`${t.status} in ('pending','approved','rejected','cancelled','voided','superseded_by_work')`,
    ),
    check('leave_request_days_frozen_pair_check', sql`(${t.frozenAt} is null) = (${t.frozenByPayRunId} is null)`),
    check(
      'leave_request_days_frozen_shape_check',
      sql`${t.frozenByPayRunId} is null or (${t.status} = 'approved' and ${t.paid} and ${t.kind} = 'leave')`,
    ),
    foreignKey({ columns: [t.orgId, t.requestId], foreignColumns: [leaveRequests.orgId, leaveRequests.id], name: 'leave_request_days_request_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.personId], foreignColumns: [persons.orgId, persons.id], name: 'leave_request_days_person_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.employmentId], foreignColumns: [employments.orgId, employments.id], name: 'leave_request_days_employment_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'leave_request_days_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.frozenByPayRunId], foreignColumns: [payRuns.orgId, payRuns.id], name: 'leave_request_days_frozen_by_pay_run_id_same_org_fk' }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------

/**
 * The year-end (or final-pay) cash payout of the person's unused Service Incentive Leave. One per PERSON per year.
 * Paid by a pay run OR by a separation's final pay, never both: the CHECK below and the frozen check at both payers.
 */
export const leaveCommutations = pgTable(
  'leave_commutations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    personId: uuid('person_id').notNull(),
    year: integer('year').notNull(),
    /** The designated employment: open on 31 Dec with the earliest `started_on` (ties: lowest id). */
    employmentId: uuid('employment_id').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull(),
    dailyRate: numeric('daily_rate', { precision: 14, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    frozenByPayRunId: uuid('frozen_by_pay_run_id').references(() => payRuns.id, { onDelete: 'restrict' }),
    separationId: uuid('separation_id').references(() => separations.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('leave_commutations_person_year_unique').on(t.personId, t.year),
    index('leave_commutations_run_idx')
      .on(t.frozenByPayRunId)
      .where(sql`${t.frozenByPayRunId} is not null`),
    index('leave_commutations_separation_idx')
      .on(t.separationId)
      .where(sql`${t.separationId} is not null`),
    check('leave_commutations_year_check', sql`${t.year} between 2000 and 2200`),
    check(
      'leave_commutations_amounts_nonnegative_check',
      sql`${t.days} >= 0 and ${t.dailyRate} >= 0 and ${t.amount} >= 0`,
    ),
    check('leave_commutations_days_finite_check', sql`${t.days} > '-Infinity'::numeric and ${t.days} < 'Infinity'::numeric`),
    check('leave_commutations_daily_rate_finite_check', sql`${t.dailyRate} > '-Infinity'::numeric and ${t.dailyRate} < 'Infinity'::numeric`),
    check('leave_commutations_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    check('leave_commutations_frozen_pair_check', sql`(${t.frozenAt} is null) = (${t.frozenByPayRunId} is null)`),
    check(
      'leave_commutations_one_payer_check',
      sql`not (${t.frozenByPayRunId} is not null and ${t.separationId} is not null)`,
    ),
    foreignKey({ columns: [t.orgId, t.personId], foreignColumns: [persons.orgId, persons.id], name: 'leave_commutations_person_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.employmentId], foreignColumns: [employments.orgId, employments.id], name: 'leave_commutations_employment_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [persons.orgId, persons.id], name: 'leave_commutations_created_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.frozenByPayRunId], foreignColumns: [payRuns.orgId, payRuns.id], name: 'leave_commutations_frozen_by_pay_run_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.separationId], foreignColumns: [separations.orgId, separations.id], name: 'leave_commutations_separation_id_same_org_fk' }).onDelete('restrict'),
  ],
);
