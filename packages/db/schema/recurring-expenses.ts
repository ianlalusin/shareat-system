/**
 * Recurring-expense TEMPLATES — the fixed bills that should not depend on somebody remembering
 * them. T-216.
 *
 * ## A template, not a document
 *
 * It carries no journal entry, no money and no status beyond active/paused. It describes *what
 * recurs, where, how often, and roughly how much*. `default_amount` is a DEFAULT: rent is fixed,
 * electricity is not, and the drafted expense is editable before anyone posts it.
 *
 * ## ⛔ THERE ARE NO SYSTEM ROWS HERE, AND THE ABSENCE IS THE FEATURE
 *
 * v1 seeds **five payroll rows** into `recurringExpenses` and then builds TWO independent
 * mechanisms to stop anyone confirming them — an `isSystem` flag and a frozen `payroll__` id
 * prefix, described in its own source as *"belt and braces: a row whose flag was stripped by a hand
 * edit is still recognised by its id."* They shipped **active and confirmable**, and confirming one
 * would have posted a second real cash movement for a payroll already paid per staffer, or
 * expensed a statutory contribution already withheld into a liability. **Double-counting, twice
 * over.**
 *
 * ⭐ The correct fix for *"five rows nobody may confirm"* is not to gate them. It is **not to
 * create them.** v2's payroll posts its own salaries expense and its own statutory liabilities
 * (T-189, T-190, T-193), and a statutory remittance **debits a liability** — it is not an OPEX
 * expense, and modelling it as a recurring one is what made v1's rows dangerous.
 *
 * ⚠️ So if this table ever looks suspiciously empty of payroll, that is deliberate. **Rent,
 * utilities, internet, subscriptions and equipment leases are the whole population.**
 *
 * ## ⚠️ The cashier till, and why it is a constraint rather than a fallback
 *
 * v1 resolves an ambiguous scheduled payment to **office cash** at runtime, because *"a
 * recurring/scheduled payment must never silently draw from the cashier till"* — the till is the
 * daily operating drawer. v2 makes that structural: a template may name a cashier account only
 * when a person deliberately chose it, recorded in `till_is_deliberate`. A runtime fallback answers
 * *"what do we do with a bad value?"*; a constraint answers *"how did a bad value get stored?"* —
 * and only the second one stops it recurring.
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
  uuid,
} from 'drizzle-orm/pg-core';
import { expenseCategories, expenses } from './expenses';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { suppliers } from './suppliers';

export const RECURRING_INTERVALS = ['weekly', 'bi_weekly', 'monthly', 'quarterly', 'annually'] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

export const RECURRING_STATUSES = ['active', 'paused'] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];

export const recurringExpenses = pgTable(
  'recurring_expenses',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    /** What a person calls it — "Lipa branch rent". */
    name: text('name').notNull(),
    categoryId: uuid('category_id').notNull().references(() => expenseCategories.id, { onDelete: 'restrict' }),
    /**
     * ⛔ **The column that makes drafting possible at all** — T-216 Part 2 (§J5.1).
     *
     * The original spec assumed the job could call `createExpense` "unchanged". It cannot:
     * `expenses.supplier_id` and `expenses.supplier_invoice_id` are both NOT NULL, gated inside
     * `createExpense` and backstopped by the `expenses_check_invoice_open_for_recording` trigger,
     * and `createExpense` is the **only** caller of `insertExpense` in the tree. A machine with no
     * supplier cannot record an expense. So the template names one and the job records the pending
     * invoice against it — which is also the accounting-correct shape: a recurring bill comes FROM
     * somebody (the landlord, the utility), and that party is what the AP side needs.
     *
     * ⚠️ **Nullable, deliberately.** Templates created before this column existed have no supplier
     * and a NOT NULL would refuse the migration. The rule lives where it can be *reported* instead:
     * the job refuses such a template and names it in the run's failures, and `/expenses/recurring`
     * says which ones are unset — the same insist-on-screen shape T-229 used for the TIN. A newly
     * created template must name one (`createRecurringTemplate`).
     */
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'restrict' }),
    /** ⚠️ A DEFAULT, not the amount. The drafted expense is edited against the real bill. */
    defaultAmount: numeric('default_amount', { precision: 14, scale: 2 }).notNull(),
    defaultMoneyAccountId: uuid('default_money_account_id').references(() => moneyAccounts.id, {
      onDelete: 'restrict',
    }),
    /**
     * ⛔ Set only when the default account is a CASHIER account and a person chose it knowingly.
     * v1's whole `payment-routing.ts` exists because a scheduled payment could drift onto the till;
     * here the drift is unrepresentable and the deliberate case is a recorded fact.
     */
    tillIsDeliberate: boolean('till_is_deliberate').notNull().default(false),
    interval: text('interval', { enum: RECURRING_INTERVALS }).notNull(),
    /** Day of the MONTH (1–31) for the monthly family, day of the WEEK (0–6) for the weekly one. */
    anchorDay: integer('anchor_day').notNull(),
    /** ⭐ The job's ONLY cursor. One column, so "did this already draft?" has one answer. */
    nextDueDate: date('next_due_date').notNull(),
    status: text('status', { enum: RECURRING_STATUSES }).notNull().default('active'),
    /**
     * Provenance — which expense this template last produced, and when.
     *
     * ⛔ **`ON DELETE SET NULL`, and it is the one FK in this table that is not `restrict`.**
     * The template is cutover class KEEP (a standing fact about how the business operates); the
     * expense is class PURGE. A `restrict` here would make the template BLOCK the 1 January purge
     * of the very table it points at — found by writing the classification entry, not by running
     * the purge, which is the only reason it was found before December. Provenance of a deleted
     * draft is worth nothing, so nulling it is the honest outcome rather than a compromise.
     */
    lastDraftedExpenseId: uuid('last_drafted_expense_id').references(() => expenses.id, { onDelete: 'set null' }),
    lastDraftedAt: timestamp('last_drafted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** The job's query: everything active and due, for one org. */
    index('recurring_expenses_due_idx').on(t.orgId, t.status, t.nextDueDate),
    index('recurring_expenses_store_idx').on(t.storeId, t.status),
    index('recurring_expenses_supplier_idx').on(t.supplierId),
    check('recurring_expenses_amount_check', sql`${t.defaultAmount} > 0`),
    /**
     * ⭐ ONE check, BOTH families — the anchor must be in range **for its own interval**.
     *
     * ⚠️ v1 stores an out-of-range anchor happily and clamps at read time, so a template can hold
     * `dayOfMonth: 45` for ever and merely behave as though it said 31. Putting the rule here means
     * the bad value cannot be stored at all. ⛔ Note what it does NOT refuse: 29, 30 and 31 are all
     * valid, because they clamp — refusing them would make "the last day of the month"
     * unexpressible, and that is one of the commonest real anchors there is.
     */
    check(
      'recurring_expenses_anchor_day_check',
      sql`(${t.interval} in ('weekly','bi_weekly') and ${t.anchorDay} between 0 and 6)
          or (${t.interval} in ('monthly','quarterly','annually') and ${t.anchorDay} between 1 and 31)`,
    ),
  ],
);
