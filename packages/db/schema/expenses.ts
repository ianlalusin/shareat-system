/**
 * expenses + expense_payments + expense_categories — non-inventory spend.
 * docs/tasks/122-expenses.md.
 *
 * A DELIVERY is a purchase in its own right (bible row 119) and books AP directly at
 * receipt; it is a SEPARATE document, Phase 3, with no link back here — this table
 * deliberately carries no `delivery_id` (spec §"No delivery_id column"). An EXPENSE is
 * everything else non-inventory spend: 64% of v1's captured expense documents.
 *
 * `expense_payments` is ONE expense, MANY payments — the normal case in this business,
 * not the exception (invariant 2): a ₱3,500 supplies order paid partly cash, partly
 * online is the single most common shape in the whole v1 dataset. All of an expense's
 * payments post as credit lines on ONE journal entry (packages/domain/src/expenses's
 * `approve` service + `routing.ts`), never one entry per payment.
 *
 * `expense_categories` is the seeded, already-decided category -> account crosswalk
 * (packages/etl/src/leg-mapping.ts's OPEX_CATEGORY_ACCOUNTS / COGS_CATEGORY_ACCOUNTS,
 * mirrored — not imported, see routing.ts's top comment — into
 * packages/db/seed/expense-categories.ts). `account_code` is NULLABLE on purpose (§4):
 * a category with no mapped account BLOCKS posting rather than falling back to 6900
 * (invariant 7). `PERSONAL` and `CAPEX` are ordinary rows here too — seeded with
 * account_code 3200 (owner's drawings) and 1510 (property and equipment) respectively
 * (invariants 8, 9) — so the posting logic never special-cases them by group; whatever
 * account_code the chosen category resolves to is what gets debited.
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
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { moneyAccounts } from './money-accounts';

// -------------------------------------------------------------------------------------
// expense_categories — reference data, seeded from the already-decided crosswalk.
// -------------------------------------------------------------------------------------

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    group: text('group', { enum: ['OPEX', 'COGS', 'CAPEX', 'PERSONAL'] }).notNull(),
    category: text('category').notNull(),
    subCategory: text('sub_category'),
    // NULLABLE ON PURPOSE (§4) — a category with no account mapped blocks posting rather
    // than defaulting to 6900 (invariant 7). Never given a default value.
    accountCode: text('account_code'),
    /** ⭐ Spend in this category MAY be a prepayment (T-125 §11, option B). Insurance, permits,
     *  multi-month rent advances — the things v1 marks `capitalizable` on its 22 seeded templates. */
    prepaidEligible: boolean('prepaid_eligible').notNull().default(false),
    /** The coverage term to apply when nobody has said otherwise. ⚠️ It is a GUESS — the invoice
     *  knows ₱24,000, only a person knows it buys twelve months — which is why an auto-created
     *  prepaid item is flagged `needs_review`. v1's `sys_rent` carries 1 here deliberately, so
     *  ordinary monthly rent stays an immediate expense while a multi-month advance routes prepaid. */
    defaultCoverageMonths: integer('default_coverage_months'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // Category strings are unique per org — leg-mapping.ts's crosswalk keys are already
    // globally unique (no OPEX/COGS name collision), and expenses.category_id resolves
    // routing by id, never by re-matching the string, but the picker needs this to stay
    // meaningful.
    uniqueIndex('expense_categories_org_id_category_unique').on(t.orgId, t.category),
    index('expense_categories_org_id_group_idx').on(t.orgId, t.group),
    check('expense_categories_group_check', sql`${t.group} in ('OPEX', 'COGS', 'CAPEX', 'PERSONAL')`),
  ],
);

// -------------------------------------------------------------------------------------
// expenses — the document header.
// -------------------------------------------------------------------------------------

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    // The business day this spend belongs to — NOT created_at (bible §6 "Dates & time":
    // an explicit business_date column, computed once on write). Resolves to a fiscal
    // period only at posting time (postEntry itself, never re-derived here).
    businessDate: date('business_date').notNull(),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id, { onDelete: 'restrict' }),
    // Opaque text, not a FK — no suppliers table exists until Wave 3 (spec §1). Read only
    // when a payment's method is 'credit' (the AP party).
    supplierId: text('supplier_id'),
    particulars: text('particulars').notNull(),
    // The receipt-photo gate (§5, DEF-055): every expense recorded through this module is
    // external by construction, so "no photo, no posting" is simply "this must be set
    // before status can become 'posted'" — enforced in the service layer (approve.ts),
    // never merely in the form. Nullable here because a DRAFT may exist before the photo
    // is attached.
    receiptPhotoUrl: text('receipt_photo_url'),
    /** ⭐ The brokered file behind the photo gate (T-141). ⚠️ `receipt_photo_url` above stays
     *  during the expand phase; contracting it is a separate migration once nothing reads it. */
    receiptFileId: uuid('receipt_file_id'),
    status: text('status', { enum: ['draft', 'posted', 'voided'] })
      .notNull()
      .default('draft'),
    // Set on approve() (the posting step — spec Scope: "create · approve · void, posting
      // via postEntry"). Never set any other way.
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    approvedBy: uuid('approved_by').references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('expenses_org_id_store_id_idx').on(t.orgId, t.storeId),
    index('expenses_org_id_business_date_idx').on(t.orgId, t.businessDate),
    index('expenses_category_id_idx').on(t.categoryId),
    index('expenses_status_idx').on(t.status),
    index('expenses_created_by_idx').on(t.createdBy),
    check('expenses_status_check', sql`${t.status} in ('draft', 'posted', 'voided')`),
    check('expenses_total_amount_positive_check', sql`${t.totalAmount} > 0`),
  ],
);

// -------------------------------------------------------------------------------------
// expense_payments — ONE expense, MANY payments (invariant 2). The funding side.
// -------------------------------------------------------------------------------------

export const expensePayments = pgTable(
  'expense_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    method: text('method', {
      enum: ['cash', 'online', 'credit', 'other', 'reimbursable', 'ar_collection'],
    }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    // Free text, read only for a 'cash' payment's office/cashier sub-route (the literal
    // value 'office' routes to 1130 instead of 1110 — see
    // packages/domain/src/expenses/routing.ts's top comment: this mirrors v1's
    // ExpensePaymentSplit.accountId 'office' flag via convert.ts's already-decided
    // fundingLine behaviour). No other value is read by the posting logic today.
    accountCode: text('account_code'),
    // The reimbursable party (2130) — required for that method (invariant 3); the
    // requires_party trigger rejects the line without it regardless, this just names the
    // reason earlier. References persons directly: staff, unlike suppliers, already have
    // a table (T-101).
    staffId: uuid('staff_id').references(() => persons.id, { onDelete: 'restrict' }),
    /** ⭐ WHICH wallet an ONLINE payment moved (ADR-010, migration 0025). `1140` is a control
     *  account covering every wallet, so the posting names one as its party — the same shape
     *  `2110` uses for suppliers. Null for cash: 1110/1120/1130 already say where the money is.
     *  ⚠️ A real FK, unlike `journal_lines.party_id` — a source document has no reason to defer
     *  referential integrity the way that narrow, multi-party column does (DEF-040). */
    moneyAccountId: uuid('money_account_id').references(() => moneyAccounts.id, {
      onDelete: 'restrict',
    }),

    // Opaque text, not a FK — cash requests are not yet a table in this schema (their own
    // future task; POSTING-PATTERNS.md's cash_request_release/_return sourceTypes exist
    // independently of this column). Presence alone routes a cash payment to 1120 instead
    // of 1110.
    cashRequestId: text('cash_request_id'),
  },
  (t) => [
    index('expense_payments_expense_id_idx').on(t.expenseId),
    index('expense_payments_staff_id_idx').on(t.staffId),
    check(
      'expense_payments_method_check',
      sql`${t.method} in ('cash', 'online', 'credit', 'other', 'reimbursable', 'ar_collection')`,
    ),
    check('expense_payments_amount_positive_check', sql`${t.amount} > 0`),
  ],
);
