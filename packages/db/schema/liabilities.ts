/**
 * Generic liabilities — what the business owes that nothing else already tracks. T-128.
 *
 * ## ⛔ There are NO balance columns here, for the fourth time
 *
 * v1 keeps `outstandingBalance`, `totalCharged` and `totalPaid` on the account, plus a
 * `LiabilityLedgerEntry` with its own `balanceBefore` / `balanceAfter`, beside the journal that
 * already holds the same movements (DEF-074). Identical to the loans (bible row 158), owner equity
 * (DEF-072) and the cash requests — found independently each time.
 *
 * Here every figure is summed from `2500` by party. `outstanding = charged − paid` is arithmetic on
 * one balance, and **settled means that balance reached zero** rather than a column saying so.
 *
 * ## ⭐ `due_on` is a genuine ADD
 *
 * v1 has no due date on a liability at all, so it can show what is owed and never what is LATE —
 * the question people open the screen to ask.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** v1's four, kept verbatim — they are how the business already labels these. */
export const LIABILITY_CATEGORIES = [
  'taxes_payable',
  'government_contributions',
  'accrued_expenses',
  'other',
] as const;
export type LiabilityCategory = (typeof LIABILITY_CATEGORIES)[number];

export const liabilities = pgTable(
  'liabilities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    category: text('category', { enum: LIABILITY_CATEGORIES }).notNull().default('other'),
    description: text('description'),

    /**
     * ⭐ **When it is due.** Nullable, because some obligations genuinely have no date — but an
     * obligation WITHOUT one can never be reported late, which is exactly v1's gap.
     */
    dueOn: date('due_on'),

    /**
     * ⚠️ **Retired, not deleted, and NOT the same as settled.** Settled is derived from the ledger;
     * this says somebody decided to stop using the row. A settled obligation stays active until
     * someone retires it, because a balance of zero today is not a promise of zero tomorrow.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),

    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('liabilities_org_store_idx').on(t.orgId, t.storeId),
    index('liabilities_due_on_idx').on(t.dueOn),

    check('liabilities_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check(
      'liabilities_category_check',
      sql`${t.category} in ('taxes_payable','government_contributions','accrued_expenses','other')`,
    ),
  ],
);
