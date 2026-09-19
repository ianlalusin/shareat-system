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
 *
 * ⭐ T-130: `supplierId` and `supplierInvoiceId` are now NOT NULL — every expense recorded
 * through this module names a supplier and a verified invoice, cash included, not only credit
 * ones (`docs/tasks/130-accounts-payable.md`). The photo gate (DEF-055) moved to
 * `supplier_invoices`; this table no longer carries `receiptPhotoUrl`/`receiptFileId`.
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
import { cashRequests } from './cash-requests';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { owners } from './owners';
import { persons } from './persons';
import { stores } from './stores';
import { moneyAccounts } from './money-accounts';
import { supplierInvoices, suppliers } from './suppliers';

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
    /** ⭐ T-229 slice 2, bible §4.4 rule 2. Seeded rows are DEACTIVATED, never deleted, and a user
     *  row and a seeded row are never confused for one another (rule 5: the seed owns system rows,
     *  the screen owns user rows, neither writes the other's). */
    isSystem: boolean('is_system').notNull().default(false),
    /** Retiring keeps the category readable on every expense already posted against it. */
    isActive: boolean('is_active').notNull().default(true),
    // ⛔ `sub_category` was DROPPED in migration 0134 (T-229 slice 2). NULL on all 38 seeded rows,
    //    and v1's second free-text level is what produced its 8 catch-all categories
    //    (discovery 08 §5.5). ⚠️ It had no data but FOUR live SQL readers, three of them raw
    //    template strings TypeScript could not see — see 0134's header before re-adding anything
    //    like it.
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
    // NOTE: uniqueness is `(org_id, lower(trim(category)))` — case- and whitespace-INSENSITIVE,
    // bible §4.4 rule 3, DEF-205. That is an expression index Drizzle's builder cannot express; it
    // is hand-added in migration 0134, exactly as `positions` (employment.ts:126-134) and
    // `sales_channels` (0133) already document.
    // ⛔ Do NOT restore a `uniqueIndex(...)` line here. The builder can only express the
    // case-SENSITIVE version, and `db:generate` would then "fix" the drift by dropping the correct
    // index and recreating the broken one (DEF-073's shape).
    // ⚠️ `group` is deliberately NOT in the key: including it would allow "Rent" in OPEX and
    // "rent" in COGS, which is the duplicate the index exists to refuse.
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
    /**
     * ⭐ T-130: was opaque text ("no suppliers table exists until Wave 3"); now a real FK,
     * NOT NULL. Every expense recorded through this module names a supplier now — Ian,
     * 2026-08-27, confirmed universal (cash included, not only credit/AP) against this spec's
     * own credit-only proposal. Read for the AP party only when a payment's method is 'credit'.
     */
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /**
     * ⭐ T-130 — the gate. NOT NULL: an expense cannot exist without naming the (verified)
     * invoice it was recorded against. Enforced twice: here for a clean error at the moment of
     * insert, and by the hand-written `expenses_require_verified_invoice` trigger (migration,
     * DEF-073) that is the actual backstop regardless of which code path writes the row — same
     * reasoning as T-118's `journal_lines_check_party_requirement`.
     *
     * Also carries receipt-date authority (`docs/tasks/130-accounts-payable.md` Invariant 3,
     * ported from v1's `expense.actions.ts:179-197`): `businessDate` above is always resolved
     * from `supplierInvoices.invoiceDate` server-side, never trusted from the client.
     */
    supplierInvoiceId: uuid('supplier_invoice_id')
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: 'restrict' }),
    /**
     * ⭐ **Which owner a PERSONAL expense belongs to.** Null for every other category. T-127.
     *
     * ⚠️ A personal expense IS a drawing — that is why invariant 8 routes it to `3200` rather than
     * to a P&L line. `3200` is party-requiring, and this column is the party.
     *
     * ⛔ **Without it a personal expense escapes that owner's drawing limit**, which is summed from
     * `3200` by owner. Same shape as `expense_payments.staff_id` on a reimbursable leg: the account
     * decides a party is needed, and the document supplies it. Enforced at approve, not here — a
     * DRAFT may exist before the owner is chosen.
     */
    ownerId: uuid('owner_id').references(() => owners.id, { onDelete: 'restrict' }),
    particulars: text('particulars').notNull(),
    // ⭐ T-130: the receipt-photo gate (DEF-055) RELOCATES to `supplier_invoices.receiptPhotoUrl`
    // / `.receiptFileId` — the evidence is attached and checked once, at invoice verification,
    // not re-attached on every expense recorded against it. `receiptPhotoUrl`/`receiptFileId`
    // columns removed from this table; approve.ts's photo-gate check is removed with them (see
    // that file's own comment and DEFECTS-REGISTER.md's DEF-055 entry for the relocation note).
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
    check('expenses_total_amount_finite_check', sql`${t.totalAmount} > '-Infinity'::numeric and ${t.totalAmount} < 'Infinity'::numeric`),
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

    /**
     * ⭐ WHICH float this cash came out of — **`1120`'s party** (T-266 §4, migration 0141).
     *
     * ⚠️ **It used to be opaque `text`**, under a comment saying *"cash requests are not yet a
     * table in this schema (their own future task)"*. That stopped being true at migration
     * `0034_t144_cash_requests.sql` and the comment outlived it by six months — a text column
     * pointing at a `uuid` primary key, where a typo was storable and nothing would object.
     *
     * ⛔ **It is no longer metadata.** T-266 makes it load-bearing for posting: `1120` is a
     * control account serving every float at the store (`chart-of-accounts.ts:133`,
     * `requiresParty: true`), so this names whose money moved. Without it the credit line has no
     * party, the trigger refuses the entry, and the expense cannot post at all.
     *
     * ⚠️ Still nullable — most payments are not from a float. `routeExpense` requires it only when
     * the chosen account resolves to `1120`, and refuses by name when it is missing.
     */
    cashRequestId: uuid('cash_request_id').references(() => cashRequests.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    index('expense_payments_expense_id_idx').on(t.expenseId),
    index('expense_payments_staff_id_idx').on(t.staffId),
    check(
      'expense_payments_method_check',
      sql`${t.method} in ('cash', 'online', 'credit', 'other', 'reimbursable', 'ar_collection')`,
    ),
    check('expense_payments_amount_positive_check', sql`${t.amount} > 0`),
    check('expense_payments_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
  ],
);
