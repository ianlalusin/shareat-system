/**
 * Customer returns — the goods come back, and they hold a credit. T-179, bible row 166.
 * Sibling of T-170 (`supplier-returns.ts`), same shape pointing the other way.
 *
 * ⭐ **Not perfectly symmetric with a supplier return, and that asymmetry is named, not hidden.**
 * We recognised revenue on the way out and did not on the way in — so this document reverses
 * THREE things where T-170 reverses two: revenue (`4950`), cost (`5xxx`/inventory), and stock.
 *
 * ## `treatment` — DERIVED, never a choice (ADR-008 §8, same fact T-133 §5 already decides)
 *
 * | Counterparty | Posts |
 * |---|---|
 * | `external` / franchise | `Dr 4950 / Cr 1210, 2140 or cash` — a real reversal |
 * | `internal` — our own store | `1250`/`2150` swap, T-173 backwards — no revenue, no credit |
 *
 * `inter_entity` is accepted by the enum for symmetry with `trade_orders`' own treatment values,
 * but `createCustomerReturn` refuses it exactly as `createTradeOrder` refuses an inter-entity
 * dispatch — no second org exists in the data yet (T-133 §4).
 *
 * ## `settlement` and its check pair
 *
 * `internal` ↔ `reverse_transfer` in both directions, mirroring `trade_orders`' own
 * `trade_orders_internal_no_ar_check` shape — a store credit or a refund on a branch↔commissary
 * return would imply a credit relationship a branch does not have with its own company.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid, boolean, foreignKey } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';
import { tradeOrders, tradeOrderLines } from './trade';

export const CUSTOMER_RETURN_TREATMENTS = ['external', 'inter_entity', 'internal'] as const;
export type CustomerReturnTreatment = (typeof CUSTOMER_RETURN_TREATMENTS)[number];

/**
 * ⭐ Widened from the task spec's four values — see invariant 9: a return whose amount exceeds
 * the customer's open balance on that order splits across `reduce_ar` AND `store_credit` in ONE
 * entry, and a single-valued header needs a name for that shape. Same correction, same reasoning,
 * as T-170's `credit_basis` gaining `mixed` (see `supplier-returns.ts`'s header).
 */
export const CUSTOMER_RETURN_SETTLEMENTS = [
  'reduce_ar', 'store_credit', 'cash_refund', 'reverse_transfer', 'mixed',
] as const;
export type CustomerReturnSettlement = (typeof CUSTOMER_RETURN_SETTLEMENTS)[number];

export const CUSTOMER_RETURN_STATUSES = ['posted', 'void'] as const;
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number];

export const customerReturns = pgTable(
  'customer_returns',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    tradeOrderId: uuid('trade_order_id')
      .notNull()
      .references(() => tradeOrders.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    treatment: text('treatment', { enum: CUSTOMER_RETURN_TREATMENTS }).notNull(),
    returnedOn: date('returned_on').notNull(),
    reason: text('reason').notNull(),
    settlement: text('settlement', { enum: CUSTOMER_RETURN_SETTLEMENTS }).notNull(),
    status: text('status', { enum: CUSTOMER_RETURN_STATUSES }).notNull().default('posted'),
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
      'customer_returns_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)`,
    ),
    // ⭐ Invariant 2's DB half — internal ↔ reverse_transfer, both directions, unrepresentable
    // otherwise. Same shape as trade_orders_internal_no_ar_check.
    check(
      'customer_returns_internal_settlement_check',
      sql`${t.treatment} <> 'internal' or ${t.settlement} = 'reverse_transfer'`,
    ),
    check(
      'customer_returns_settlement_internal_check',
      sql`${t.settlement} <> 'reverse_transfer' or ${t.treatment} = 'internal'`,
    ),
    index('customer_returns_store_status_idx').on(t.storeId, t.status),
    index('customer_returns_customer_idx').on(t.customerId),
    index('customer_returns_trade_order_idx').on(t.tradeOrderId),
    index('customer_returns_org_idx').on(t.orgId),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'customer_returns_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'customer_returns_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'customer_returns_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `customer_id` FK (RLS checks only this row's org_id); references `customers_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'customer_returns_customer_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'customer_returns_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `trade_order_id` FK (RLS checks only this row's org_id); references `trade_orders_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.tradeOrderId],
      foreignColumns: [tradeOrders.orgId, tradeOrders.id],
      name: 'customer_returns_trade_order_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const customerReturnLines = pgTable(
  'customer_return_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    returnId: uuid('return_id')
      .notNull()
      .references(() => customerReturns.id, { onDelete: 'cascade' }),
    lineNo: text('line_no').notNull(),
    tradeOrderLineId: uuid('trade_order_line_id')
      .notNull()
      .references(() => tradeOrderLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** false -> the goods are wasted (T-164, reason customer_return_unsellable) after reopening. */
    saleable: boolean('saleable').notNull().default(true),
    /** Revenue reversed, at the rate CAPTURED on the order line — never today's price list. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** COGS reversed — read from `stock_layer_consumptions`, never recomputed from current layers. */
    cost: numeric('cost', { precision: 14, scale: 2 }).notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => stockMovements.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('customer_return_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    check('customer_return_lines_amount_positive_check', sql`${t.amount} > 0`),
    check('customer_return_lines_cost_non_negative_check', sql`${t.cost} >= 0`),
    uniqueIndex('customer_return_lines_return_line_key').on(t.returnId, t.lineNo),
    index('customer_return_lines_trade_order_line_idx').on(t.tradeOrderLineId),
    index('customer_return_lines_item_idx').on(t.itemId),
    check('customer_return_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    check('customer_return_lines_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    check('customer_return_lines_cost_finite_check', sql`${t.cost} > '-Infinity'::numeric and ${t.cost} < 'Infinity'::numeric`),
  ],
);
