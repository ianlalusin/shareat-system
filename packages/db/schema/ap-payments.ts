/**
 * AP payments — settling a supplier, against named open invoices. T-130.
 *
 * ⛔ **No stored `outstanding`/`allocated` total anywhere.** Every balance — per supplier, per
 * invoice, the `2110` control total — is summed from `journal_lines`, the same discipline every
 * control account in this schema has followed since T-118 (DEF-075's pattern, found five times
 * before this task).
 *
 * `docs/POSTING-PATTERNS.md`'s `ap_payment.simple` / `.overpayment` name the legs:
 * `Dr 2110 (allocated) · Dr 1240 (unallocated, overpayment only) · Cr the funding account`.
 * `ap_payment_allocations` is what a stored `journal_lines` party alone cannot say — WHICH open
 * invoice(s) a payment settles (bible §16.10: "payments must name the open items they settle").
 *
 * ⚠️ **`moneyAccountId` is ALWAYS required, never a `cashier`/`office`/`online` label.** ADR-010 /
 * DEF-058: *"the owner belongs to the ACCOUNT — it should be derived, never ticked."*
 * `expense_payments`/`routing.ts` already made cash and online ONE branch for exactly this
 * reason — a custodian typed by the user is how v1's office-drawer checkbox happened. There is no
 * separate `funding_source` enum here; the account's own `custodian` column says who holds it.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cashRequests } from './cash-requests';
import { expenses } from './expenses';
import { journalEntries } from './journal';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { suppliers } from './suppliers';

export const AP_PAYMENT_STATUSES = ['draft', 'posted', 'voided'] as const;
export type ApPaymentStatus = (typeof AP_PAYMENT_STATUSES)[number];

export const apPayments = pgTable(
  'ap_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),

    businessDate: date('business_date').notNull(),
    /** The TOTAL handed over — allocated + unallocated (overpayment), never just the AP portion. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),

    /** ⭐ ALWAYS required — the one money account this payment left. Its `custodian` (cashier /
     *  office / staff) and `instrument` decide the GL code; neither is typed by the caller. */
    moneyAccountId: uuid('money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    /** ⭐ Attribution only, mirroring `expense_payments.cashRequestId`'s exact role: set when this
     *  payment drew on a released cash request (a staff-custodian account). A REAL FK, unlike
     *  `expense_payments.cashRequestId`'s opaque text, written before T-144's `cash_requests`
     *  table existed. It does now. */
    cashRequestId: uuid('cash_request_id').references(() => cashRequests.id, {
      onDelete: 'restrict',
    }),

    referenceNo: text('reference_no'),
    notes: text('notes'),

    status: text('status', { enum: AP_PAYMENT_STATUSES }).notNull().default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('ap_payments_amount_positive_check', sql`${t.amount} > 0`),
    check('ap_payments_status_check', sql`${t.status} in ('draft','posted','voided')`),
    check(
      'ap_payments_void_shape_check',
      sql`${t.status} <> 'voided'
          or (${t.voidedBy} is not null and ${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    check('ap_payments_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    // T-357 / DEF-490, migration 0171 — the single-column FK above accepts a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). References
    // `money_accounts_org_id_id_unique` (`schema/money-accounts.ts` — hand-added in migration
    // 0171).
    foreignKey({
      columns: [t.orgId, t.moneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'ap_payments_money_account_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const apPaymentAllocations = pgTable(
  'ap_payment_allocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    apPaymentId: uuid('ap_payment_id')
      .notNull()
      .references(() => apPayments.id, { onDelete: 'cascade' }),
    /** ⚠️ The open item is an EXPENSE (T-122's credit-method booking), not the invoice header
     *  directly — an invoice can back several expense postings over time, and a payment settles
     *  the specific ones it names, exactly v1's `AllocationInput[{apId: expenseId, amountApplied}]`
     *  shape (`payment.actions.ts`). */
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'restrict' }),
    amountApplied: numeric('amount_applied', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('ap_payment_allocations_payment_expense_key').on(t.apPaymentId, t.expenseId),
    check('ap_payment_allocations_amount_positive_check', sql`${t.amountApplied} > 0`),
    check('ap_payment_allocations_amount_applied_finite_check', sql`${t.amountApplied} > '-Infinity'::numeric and ${t.amountApplied} < 'Infinity'::numeric`),
  ],
);
