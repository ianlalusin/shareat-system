/**
 * separations — an employment's end, its pro-rated 13th month, and the clearance gate. T-192.
 * `docs/tasks/192-separation-final-pay-clearance.md`.
 *
 * ⭐ **`separation_pay_amount` is manually entered, never derived.** PH separation pay is owed
 * only for authorized causes (Labor Code Art. 298/299) at cause-specific multipliers; just cause
 * and resignation legally owe none. Auto-computing from `cause` would be encoding a legal formula
 * this build was never asked to encode — see the task spec §1. `cause` is captured for the record
 * and for whoever eventually automates this properly, not consumed by any calculation here.
 *
 * ⛔ **This table's existence changes T-191's own behaviour.** `preview13thMonthRun` now excludes
 * any employment with a POSTED row here for the target year, so the annual run does not also pay
 * a 13th month this table already paid, pro-rated, at separation. See `thirteenth-month.ts`'s
 * `hasPostedSeparationInYear`.
 */
import { sql } from 'drizzle-orm';
import { check, date, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const SEPARATION_CAUSES = [
  'resignation',
  'just_cause',
  'redundancy',
  'retrenchment',
  'closure',
  'disease',
  'other',
] as const;
export type SeparationCause = (typeof SEPARATION_CAUSES)[number];

export const SEPARATION_STATUSES = ['draft', 'posted', 'voided'] as const;
export type SeparationStatus = (typeof SEPARATION_STATUSES)[number];

export const separations = pgTable(
  'separations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** One separation per employment, ever — a re-hire is a NEW employment row (T-154), so this
     *  stays true even across a rehire. */
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    separationDate: date('separation_date').notNull(),
    cause: text('cause', { enum: SEPARATION_CAUSES }).notNull(),

    /** Kept alongside the derived gross, same audit reason `thirteenth_month_payouts` keeps its
     *  own components — an amount that decided somebody's money should be readable years later. */
    thirteenthMonthBasicPayEarned: numeric('thirteenth_month_basic_pay_earned', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    thirteenthMonthGross: numeric('thirteenth_month_gross', { precision: 14, scale: 2 }).notNull().default('0'),

    /** ⭐ THE decision this table exists to hold, not compute. Defaults to 0 — "not yet decided"
     *  must not read as "decided as zero" any more than an unset config value should, but the
     *  business's own confirmed answer (2026-09-01) is that zero is a legitimate, common outcome
     *  (no track record of paying it), so no separate "unset" sentinel is warranted here. */
    separationPayAmount: numeric('separation_pay_amount', { precision: 14, scale: 2 }).notNull().default('0'),

    advanceRecovered: numeric('advance_recovered', { precision: 14, scale: 2 }).notNull().default('0'),
    netPay: numeric('net_pay', { precision: 14, scale: 2 }).notNull().default('0'),

    /** ⛔ A GATE, not a derived value. `postSeparation` refuses without it — see schema comment
     *  and task spec §2.4. */
    clearanceConfirmedAt: timestamp('clearance_confirmed_at', { withTimezone: true }),
    clearanceConfirmedBy: uuid('clearance_confirmed_by').references(() => persons.id, { onDelete: 'restrict' }),
    clearanceNotes: text('clearance_notes'),

    status: text('status', { enum: SEPARATION_STATUSES }).notNull().default('draft'),
    moneyAccountId: uuid('money_account_id').references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),

    journalEntryId: uuid('journal_entry_id'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One POSTED separation per employment at a time — matches `pay_runs`/`thirteenth_month_runs`'
     *  own "void frees it to be posted again" shape. A voided separation (a correction — wrong
     *  cause, wrong date) does not permanently block that employment from ever separating. */
    uniqueIndex('separations_employment_posted_unique')
      .on(t.employmentId)
      .where(sql`${t.status} = 'posted'`),

    check('separations_cause_check', sql`${t.cause} in ('resignation','just_cause','redundancy','retrenchment','closure','disease','other')`),
    check('separations_status_check', sql`${t.status} in ('draft', 'posted', 'voided')`),
    check('separations_thirteenth_month_nonnegative_check', sql`${t.thirteenthMonthBasicPayEarned} >= 0 and ${t.thirteenthMonthGross} >= 0`),
    check('separations_separation_pay_nonnegative_check', sql`${t.separationPayAmount} >= 0`),
    check('separations_net_nonnegative_check', sql`${t.netPay} >= 0`),
    check(
      'separations_net_identity_check',
      sql`${t.netPay} = ${t.thirteenthMonthGross} + ${t.separationPayAmount} - ${t.advanceRecovered}`,
    ),
    check('separations_advance_within_gross_check', sql`${t.advanceRecovered} <= ${t.thirteenthMonthGross} + ${t.separationPayAmount}`),
    check(
      'separations_clearance_pair_check',
      sql`(${t.clearanceConfirmedAt} is null) = (${t.clearanceConfirmedBy} is null)`,
    ),
    /** ⛔ Posting without clearance is unrepresentable — the domain layer refuses it too (defence
     *  in depth: the database enforces the rule the service layer already checks). */
    check(
      'separations_posted_needs_clearance_check',
      sql`${t.status} = 'draft' or ${t.clearanceConfirmedAt} is not null`,
    ),
    check(
      'separations_posted_pair_check',
      sql`(${t.postedAt} is null) = (${t.postedBy} is null)`,
    ),
    check('separations_posted_shape_check', sql`(${t.status} = 'draft') = (${t.postedAt} is null)`),
    check(
      'separations_void_shape_check',
      sql`(${t.status} = 'voided') = (${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    check(
      'separations_posted_needs_account_check',
      sql`${t.status} = 'draft' or ${t.moneyAccountId} is not null`,
    ),
  ],
);
