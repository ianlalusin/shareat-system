/**
 * Expense budgets — the envelope a store spends a category out of. T-215.
 *
 * ## ⛔ A budget is NOT a ledger document, and nothing here may ever make it one
 *
 * A budget is an **intention**; the ledger records **facts**. Nothing in this module calls
 * `postEntry`, and there is deliberately no `journal_entry_id` column for anyone to reach for.
 * That is exactly why the task is cheap, and it is the first thing to re-read if a future change
 * starts to feel expensive.
 *
 * ## ⭐ The one column v1 has that this table refuses
 *
 * v1 stores `consumedAmount` on the budget document and increments it from the expense actions
 * (`ERP-rebuild/src/lib/actions/expense-budget.actions.ts`). It is the same defect class as AR's
 * `outstandingAmount`, which was measured **wrong on 106 of 794 live rows (13.3%)** — a
 * separately-accumulated counter drifts, and bible §4.2 rule 7 (as extended by §13 row 173) bans
 * one *"even when it is called a cache"*. Consumption here is a `sum()` over `expenses`, always.
 * `remainingAmount`, which v1 also stores, is then arithmetic on a number that is already wrong.
 *
 * ## ⛔ THE TRAP, measured before this table was designed
 *
 * Consumption must be grouped by **`category_id`**, never by `expense_categories.account_code`.
 * Three account codes in the seed are shared by **two categories each** — `6890`, `6620`, `6600`
 * (39 categories, 36 distinct codes) — so an account-code roll-up silently over-counts six
 * envelopes, and a manager sees a budget as exhausted when half the spend belongs to another one.
 * `packages/domain/tests/integration/budgets.test.ts` has the test that catches exactly this.
 *
 * ## Two interval families, and the difference is load-bearing
 *
 * - **Reset** (`daily`, `weekly`, `bi_weekly`) — the same row keeps going and its WINDOW moves.
 *   `last_reset_at` is stamped and consumption is measured from it. ⭐ v1 had to zero a stored
 *   counter to do this; deriving consumption means there is nothing to zero.
 * - **Period** (`monthly`, `quarterly`, `annually`) — a NEW row for the next period, created only
 *   once that period has actually arrived. v1's own comment gives the reason and it is ported
 *   verbatim: *"never pre-create future months, so the reissue processor can't run away."*
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { expenseCategories } from './expenses';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** ⚠️ Two families, and `REISSUE_RESET_INTERVALS` is the discriminator the job branches on. */
export const REISSUE_RESET_INTERVALS = ['daily', 'weekly', 'bi_weekly'] as const;
export const REISSUE_PERIOD_INTERVALS = ['monthly', 'quarterly', 'annually'] as const;
export const REISSUE_INTERVALS = [...REISSUE_RESET_INTERVALS, ...REISSUE_PERIOD_INTERVALS] as const;
export type ReissueInterval = (typeof REISSUE_INTERVALS)[number];

export const expenseBudgets = pgTable(
  'expense_budgets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').notNull().references(() => expenseCategories.id, { onDelete: 'restrict' }),
    /** `YYYYMM`. v1's key, ported — the period a cap applies to. */
    periodKey: text('period_key').notNull(),
    /**
     * ⚠️ **Zero is a value, not "unset".** Zero means *spend nothing in this category*; ABSENT —
     * no row at all — means *no cap*. Bible §6 states the rule generally (*"a rate of 0 is a
     * legitimate value, never 'unset'"*); it carries a live ERPNext bug behind it.
     */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    autoReissue: boolean('auto_reissue').notNull().default(false),
    reissueInterval: text('reissue_interval', { enum: REISSUE_INTERVALS }),
    /** Provenance: which row the reissue job cloned this one from. Null for a hand-set cap. */
    reissuedFromId: uuid('reissued_from_id').references((): AnyPgColumn => expenseBudgets.id, {
      onDelete: 'restrict',
    }),
    /** Reset intervals only — the start of the CURRENT window. Consumption is measured from here
     *  rather than from the period start, which is what makes a weekly cap mean anything inside a
     *  monthly key. */
    lastResetAt: timestamp('last_reset_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** ⭐ The whole integrity story: ONE envelope per category per store per period. Auto-reissue
     *  leans on it too — a second run of the job hits this constraint rather than a promise. */
    uniqueIndex('expense_budgets_unique_envelope').on(t.orgId, t.storeId, t.categoryId, t.periodKey),
    index('expense_budgets_store_period_idx').on(t.storeId, t.periodKey),
    index('expense_budgets_reissue_idx').on(t.autoReissue, t.reissueInterval),
    check('expense_budgets_period_key_check', sql`${t.periodKey} ~ '^[0-9]{6}$'`),
    check('expense_budgets_amount_check', sql`${t.amount} >= 0`),
    /**
     * ⛔ Auto-reissue without an interval is UNREPRESENTABLE.
     *
     * v1 enforces this in its action, with a comment saying exactly why: *"an auto-reissue budget
     * MUST carry a valid interval, else the reissue processor silently skips it (no-op)."* A rule
     * that important living in one service is bible §2's own example of what belongs in the
     * database — and note the phrasing bible row 104 demands: this names **what the database
     * refuses**, not what our code declines to write.
     */
    check(
      'expense_budgets_reissue_interval_check',
      sql`${t.autoReissue} = false or ${t.reissueInterval} is not null`,
    ),
  ],
);
