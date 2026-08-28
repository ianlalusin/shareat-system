/**
 * Wholesale orders — the document a franchisee sale has never had. T-132.
 *
 * ## ⛔ What was wrong before this
 *
 * `ar_charges` carries a total and a caller-chosen revenue account, and **no lines**. So a sale to
 * a franchisee was a lump sum, and three shipped features had no reader:
 *
 * | Shipped | Consumed by | Before this task |
 * |---|---|---|
 * | `items` (T-145) | the order line | nothing — a charge names no item |
 * | `price_lists` (T-129) | the captured rate | nothing — the price was retyped from memory |
 * | `sellable_wholesale` (T-149) | the line guard | nothing — no line to guard |
 *
 * ## ⭐ One document, not four — and that is precedent, not a shortcut
 *
 * `docs/discovery/19-b2b-order-to-cash.md` read four systems at controller level. Tryton collapses
 * Quote/SalesOrder/DeliveryNote/Invoice into ONE `sale.sale` record; Dolibarr bills straight from a
 * validated order with no shipment document at all. ADR-008 §8's one-document shape is corroborated
 * by two real systems rather than argued from first principles.
 *
 * ⚠️ **Dispatch IS the billing event.** The alternative — billing that lags and batches several
 * dispatches — needs an interim account and an unbilled-dispatch report. Build it when a buyer asks
 * for period-batched invoices, which is a visible trigger rather than a guess.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { arCharges } from './ar';
import { customers } from './customers';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const TRADE_ORDER_STATUSES = ['draft', 'confirmed', 'dispatched', 'received', 'void'] as const;
export type TradeOrderStatus = (typeof TRADE_ORDER_STATUSES)[number];

export const tradeOrders = pgTable(
  'trade_orders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * The **selling** store. ⭐ Sellability is resolved here, not org-wide: Lipa may sell the
     * bulgogi sauce it makes while a branch that only buys it in may not (T-149).
     */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    orderDate: date('order_date').notNull(),
    referenceNo: text('reference_no'),
    notes: text('notes'),
    status: text('status', { enum: TRADE_ORDER_STATUSES }).notNull().default('draft'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    /**
     * ⭐ T-151. Outbound freight — us to the receiving store. Ian, 2026-08-28: *"delivery fee on
     * top of that is the fee from Lipa to Malvar."*
     *
     * ⛔ **ON TOP, never into the item's cost.** It is a haulage charge for one shipment, not a
     * property of the item — loading it in would make the same item cost different depending on
     * how it happened to travel. It rides the transfer posting, so it lands on the receiving
     * store like the goods do, with no separate freight leg and no freight account.
     */
    deliveryFee: numeric('delivery_fee', { precision: 14, scale: 2 }).notNull().default('0'),
    otherFees: numeric('other_fees', { precision: 14, scale: 2 }).notNull().default('0'),
    /**
     * ⭐ The receivable raised at dispatch — **linked, never duplicated**. The money lives in
     * `ar_charges`, and T-131's own code collects, ages and writes it off. A second copy of the
     * balance here is exactly the stored-derivation mistake AR was built to avoid (13.3% drift in
     * v1's own `outstandingAmount`).
     */
    arChargeId: uuid('ar_charge_id').references(() => arCharges.id, { onDelete: 'restrict' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    dispatchedBy: uuid('dispatched_by').references(() => persons.id, { onDelete: 'restrict' }),
    /** ⚠️ T-133. Who signed for the goods. Posts nothing for a same-org transfer — the value
     *  already moved at dispatch, in one entry. It is a recorded fact, not a posting trigger. */
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: uuid('received_by').references(() => persons.id, { onDelete: 'restrict' }),
    /** Who let a dispatch through despite the credit limit, and why. Both or neither. */
    creditOverrideBy: uuid('credit_override_by').references(() => persons.id, { onDelete: 'restrict' }),
    creditOverrideReason: text('credit_override_reason'),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('trade_orders_total_positive_check', sql`${t.totalAmount} > 0`),
    check(
      'trade_orders_dispatch_shape_check',
      sql`${t.status} <> 'dispatched' or (${t.dispatchedAt} is not null and ${t.dispatchedBy} is not null and ${t.arChargeId} is not null)`,
    ),
    check(
      'trade_orders_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedBy} is not null and ${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    check(
      'trade_orders_received_shape_check',
      sql`(${t.receivedAt} is null) = (${t.receivedBy} is null)`,
    ),
    check(
      'trade_orders_credit_override_shape_check',
      sql`(${t.creditOverrideBy} is null) = (${t.creditOverrideReason} is null)`,
    ),
    index('trade_orders_org_customer_idx').on(t.orgId, t.customerId),
    index('trade_orders_org_store_date_idx').on(t.orgId, t.storeId, t.orderDate),
    uniqueIndex('trade_orders_ar_charge_key').on(t.arChargeId).where(sql`${t.arChargeId} is not null`),
  ],
);

export const tradeOrderLines = pgTable(
  'trade_order_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => tradeOrders.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit').notNull(),
    /**
     * ⭐ **CAPTURED at line creation — never a live join to `price_list_items`.**
     *
     * An agreed price must not move. A live join means editing a price list silently reprices
     * every open order, and every system studied copies the rate forward rather than re-deriving
     * it (ERPNext maps `rate` source→target at every document hop).
     *
     * ⚠️ This is one of the few places the project's derive-don't-store instinct (bible §4.2
     * rule 7) points the WRONG way, which is why it is written down here.
     */
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('trade_order_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    check('trade_order_lines_rate_non_negative_check', sql`${t.rate} >= 0`),
    check('trade_order_lines_total_positive_check', sql`${t.lineTotal} > 0`),
    index('trade_order_lines_order_idx').on(t.orderId),
    index('trade_order_lines_org_item_idx').on(t.orgId, t.itemId),
  ],
);
