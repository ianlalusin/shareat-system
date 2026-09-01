/**
 * thirteenth_month_runs + thirteenth_month_payouts — the annual statutory bonus. T-191.
 * `docs/tasks/191-thirteenth-month-pay.md`.
 *
 * ## ⛔ Why this is NOT `pay_runs` / `payslips` wearing a new name
 *
 * `pay_runs`' overlap guard is a GiST EXCLUDE on a date RANGE, built to stop two regular periods
 * double-paying the same attendance days. A 13th-month "period" is the whole calendar year, which
 * nests inside every regular period already posted for it — tripping a guard built for a different
 * mistake. `payslips` requires a `pay_rate_id` and carries per-day attendance minutes; a 13th-month
 * payout is a sum across however many rates were in force across the year, computed from no single
 * rate and no single day. Forcing either shape to fit would mean setting fields to values that
 * satisfy a CHECK without meaning anything — the exact landmine the bible names repeatedly.
 *
 * So this mirrors the *pattern* (run → payout → journal entry, one row per employment) without
 * inheriting fields that do not apply. A `year`, not a range. No rate FK. No attendance minutes.
 */
import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const THIRTEENTH_MONTH_RUN_STATUSES = ['draft', 'posted', 'voided'] as const;
export type ThirteenthMonthRunStatus = (typeof THIRTEENTH_MONTH_RUN_STATUSES)[number];

/**
 * One store, one calendar year.
 *
 * ⭐ The uniqueness is `(store_id, year)` **where posted** — a plain unique index is enough,
 * unlike `pay_runs`' GiST exclude, because a year cannot partially overlap another year. Voiding
 * frees the year to be posted again, matching `pay_runs`' own "void → payable again" shape.
 */
export const thirteenthMonthRuns = pgTable(
  'thirteenth_month_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    year: integer('year').notNull(),
    status: text('status', { enum: THIRTEENTH_MONTH_RUN_STATUSES }).notNull().default('draft'),

    /** Where the net is paid from — same guard as `pay_runs.money_account_id`: the ordinary
     *  overdraft check applies, a 13th-month run is not exempt. */
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
    uniqueIndex('thirteenth_month_runs_store_year_posted_unique')
      .on(t.storeId, t.year)
      .where(sql`${t.status} = 'posted'`),

    check('thirteenth_month_runs_year_check', sql`${t.year} between 2020 and 2100`),
    check('thirteenth_month_runs_status_check', sql`${t.status} in ('draft', 'posted', 'voided')`),
    check(
      'thirteenth_month_runs_posted_pair_check',
      sql`(${t.postedAt} is null) = (${t.postedBy} is null)`,
    ),
    check(
      'thirteenth_month_runs_posted_shape_check',
      sql`(${t.status} = 'draft') = (${t.postedAt} is null)`,
    ),
    check(
      'thirteenth_month_runs_void_shape_check',
      sql`(${t.status} = 'voided') = (${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
  ],
);

/**
 * One person's 13th-month pay for one run.
 *
 * ⭐ `basicPayEarned` is kept alongside `grossPay` even though `grossPay = basicPayEarned / 12` is
 * derivable, for the same reason `payslips` keeps its component pays: an amount that decided
 * somebody's money should be readable years later without re-deriving it from rows that may have
 * changed shape by then.
 */
export const thirteenthMonthPayouts = pgTable(
  'thirteenth_month_payouts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => thirteenthMonthRuns.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),
    /** Stored as well as the employment — same reason as `payslips.person_id`: an employment can
     *  end, and this row has to stay readable without walking a chain that may have closed. */
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    basicPayEarned: numeric('basic_pay_earned', { precision: 14, scale: 2 }).notNull(),
    grossPay: numeric('gross_pay', { precision: 14, scale: 2 }).notNull(),
    /** ⛔ Capped at gross, same as `payslips.advance_recovered` — what is still owed stays owed on
     *  `1230`, it is never forced negative here. */
    advanceRecovered: numeric('advance_recovered', { precision: 14, scale: 2 }).notNull().default('0'),
    netPay: numeric('net_pay', { precision: 14, scale: 2 }).notNull(),

    journalEntryId: uuid('journal_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One payout per job per run. Two would pay the year twice. */
    uniqueIndex('thirteenth_month_payouts_run_employment_unique').on(t.runId, t.employmentId),

    check('thirteenth_month_payouts_basic_pay_nonnegative_check', sql`${t.basicPayEarned} >= 0`),
    check('thirteenth_month_payouts_gross_nonnegative_check', sql`${t.grossPay} >= 0`),
    check('thirteenth_month_payouts_net_nonnegative_check', sql`${t.netPay} >= 0`),
    check(
      'thirteenth_month_payouts_net_identity_check',
      sql`${t.netPay} = ${t.grossPay} - ${t.advanceRecovered}`,
    ),
    check(
      'thirteenth_month_payouts_advance_within_gross_check',
      sql`${t.advanceRecovered} <= ${t.grossPay}`,
    ),
  ],
);
