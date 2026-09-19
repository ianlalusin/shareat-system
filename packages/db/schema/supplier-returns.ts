/**
 * Supplier returns — the goods go back, and we hold a credit. T-170, bible row 166.
 *
 * ⭐ **A return is one act by one person — no draft state.** Unlike usage (T-168), where a floor
 * worker records and a manager posts, a return is recorded when the goods physically leave the
 * building. There is nothing to review after the fact that the void path does not already cover.
 *
 * ## The credit, and why there is no `supplier_credits` table
 *
 * Ian, 2026-08-29: *"supplier returns must be recognized as store credit for us that we can use
 * for next purchase."* The credit IS `1240 Advances to suppliers` — the same account T-130's
 * `recordPayment` already uses for an overpayment, because a return credit and an overpayment are
 * the same fact: money the supplier owes back. **A per-supplier balance is a query over
 * `journal_lines`, never a stored column** — DEF-075's pattern, refused the ninth time.
 *
 * ## `credit_basis` — DERIVED, and it can differ line by line
 *
 * ⭐ A supplier invoice's LINES link to individual `stock_layers` rows (`invoice_line_id`), not
 * the whole receipt at once — so one delivery can have some lines invoiced and others not, and a
 * return spanning both posts BOTH legs in one entry (§3 of the task spec). The header's own
 * `credit_basis` therefore needs a THIRD value, `mixed`, that the task spec's contract did not
 * list — reported as a spec correction rather than silently narrowed to fit two values. See the
 * task report.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { deliveries, deliveryLines } from './deliveries';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';
import { suppliers } from './suppliers';

/** ⭐ Widened from the task spec's `'grni' | 'supplier_advance'` — see this file's header. */
export const CREDIT_BASES = ['grni', 'supplier_advance', 'mixed'] as const;
export type CreditBasis = (typeof CREDIT_BASES)[number];

export const SUPPLIER_RETURN_STATUSES = ['posted', 'void'] as const;
export type SupplierReturnStatus = (typeof SUPPLIER_RETURN_STATUSES)[number];

export const supplierReturns = pgTable(
  'supplier_returns',
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
    /** ⭐ NULL means an untraceable return — old stock with no linkable receipt. Every LINE still
     *  derives its own credit basis independently via its own `delivery_line_id`. */
    deliveryId: uuid('delivery_id').references(() => deliveries.id, { onDelete: 'restrict' }),
    returnedOn: date('returned_on').notNull(),
    reason: text('reason').notNull(),
    creditBasis: text('credit_basis', { enum: CREDIT_BASES }).notNull(),
    status: text('status', { enum: SUPPLIER_RETURN_STATUSES }).notNull().default('posted'),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'supplier_returns_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)`,
    ),
    index('supplier_returns_store_status_idx').on(t.storeId, t.status),
    index('supplier_returns_supplier_idx').on(t.supplierId),
    index('supplier_returns_org_idx').on(t.orgId),
  ],
);

export const supplierReturnLines = pgTable(
  'supplier_return_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => supplierReturns.id, { onDelete: 'cascade' }),
    lineNo: text('line_no').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    deliveryLineId: uuid('delivery_line_id').references(() => deliveryLines.id, { onDelete: 'restrict' }),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => stockMovements.id, { onDelete: 'restrict' }),
    /** ⭐ The layer cost actually relieved (oldest-first, T-162) — NOT the original delivery's
     *  cost if that lot has since been partly consumed. Weighted average across the layers this
     *  line's quantity was relieved from. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
    /** This LINE's own derived basis — the header rolls these up (see schema header). */
    creditBasis: text('credit_basis', { enum: ['grni', 'supplier_advance'] as const }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('supplier_return_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    check('supplier_return_lines_unit_cost_non_negative_check', sql`${t.unitCost} >= 0`),
    uniqueIndex('supplier_return_lines_return_line_key').on(t.returnId, t.lineNo),
    index('supplier_return_lines_item_idx').on(t.itemId),
    index('supplier_return_lines_delivery_line_idx').on(t.deliveryLineId),
    check('supplier_return_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    check('supplier_return_lines_unit_cost_finite_check', sql`${t.unitCost} > '-Infinity'::numeric and ${t.unitCost} < 'Infinity'::numeric`),
  ],
);
