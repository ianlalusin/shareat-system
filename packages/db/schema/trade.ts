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
import { boolean, check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { arCharges } from './ar';
import { expenseCategories } from './expenses';
import { customers } from './customers';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stores } from './stores';

export const TRADE_ORDER_STATUSES = ['draft', 'confirmed', 'dispatched', 'received', 'void'] as const;

/** T-172. Who put a line on the order — the branch asking, or the commissary substituting. */
export const TRADE_ORDER_LINE_ORIGINS = ['requested', 'commissary_added'] as const;
export const TRADE_ORDER_LINE_APPROVALS = ['not_required', 'pending', 'approved', 'rejected'] as const;
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
    /** ⭐ Set when the BRANCH initiated this order — what makes the treatment `internal`. */
    requestedByStoreId: uuid('requested_by_store_id').references(() => stores.id, { onDelete: 'restrict' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => persons.id, { onDelete: 'restrict' }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    readyBy: uuid('ready_by').references(() => persons.id, { onDelete: 'restrict' }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => persons.id, { onDelete: 'restrict' }),
    rejectReason: text('reject_reason'),
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
    /**
     * ⛔ **This text was STALE from 2026-08-28 to 2026-08-29 and it cost a migration.** It still
     * demanded an `ar_charge_id` on every dispatch — the T-132 rule, from when every trade order
     * was a franchisee sale. **T-133 had already replaced that** in migration `0054`: what a
     * dispatched order always has is the dispatch and its journal entry, not a receivable. Only
     * the migration was updated, so this file went on stating a rule the database had stopped
     * enforcing, and T-172 wrote a migration to "fix" something already fixed — reverting it.
     *
     * ⚠️ Migrations here are hand-written (DEF-073). A constraint changed in SQL and not mirrored
     * back into this file is invisible until someone trusts the file. See DEF-095.
     */
    check(
      'trade_orders_dispatch_shape_check',
      sql`${t.status} not in ('dispatched','received') or (${t.dispatchedAt} is not null and ${t.dispatchedBy} is not null and ${t.journalEntryId} is not null)`,
    ),
    /**
     * ⭐ **The v1 mistake, made unrepresentable.** v1 books a branch transfer as an AR charge
     * against the branch-as-customer, then needs an `excludeBranchSales` flag to stop its own
     * insights being wrong. Here an internal order CANNOT carry a receivable — not by convention
     * in a posting function somebody can route around, but because the row will not store.
     */
    check(
      'trade_orders_internal_no_ar_check',
      sql`${t.requestedByStoreId} is null or ${t.arChargeId} is null`,
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

    // ---- T-172: the three quantities a branch order carries -----------------------------------
    /**
     * ⭐ **Three quantities, and collapsing any two of them loses the story.** What the branch
     * ASKED for, what the commissary actually PACKED, and what the branch SIGNED FOR. v1 keeps all
     * three for the same reason: the gap between the first two is a fulfilment decision, and the
     * gap between the last two is a discrepancy someone must dispose of (T-174).
     */
    requestedQuantity: numeric('requested_quantity', { precision: 14, scale: 3 }),
    fulfilledQuantity: numeric('fulfilled_quantity', { precision: 14, scale: 3 }),
    receivedQuantity: numeric('received_quantity', { precision: 14, scale: 3 }),
    /** Which room the goods left. ⚠️ Required at dispatch — stock leaves a place, not a store. */
    sourceLocationId: uuid('source_location_id').references(() => stockLocations.id, { onDelete: 'restrict' }),
    /**
     * ⭐ Who put this line on the order. A `commissary_added` line is a SUBSTITUTION — the
     * commissary is out of the requested item and offers another — and it always needs the
     * branch's answer before the order can move.
     */
    origin: text('origin', { enum: TRADE_ORDER_LINE_ORIGINS }).notNull().default('requested'),
    approval: text('approval', { enum: TRADE_ORDER_LINE_APPROVALS }).notNull().default('not_required'),
    /** The explicit "this line moves no branch stock" decision — v1 encodes it as a null map. */
    isLedgerOnly: boolean('is_ledger_only').notNull().default(false),
    /**
     * ⚠️ **The SAME category that gates submit and posts at receipt** — one definition, never
     * two. Copied from `commissary_item_map` when the line is created so a later edit to the map
     * cannot silently reclassify an order already in a truck.
     */
    expenseCategoryId: uuid('expense_category_id').references(() => expenseCategories.id, { onDelete: 'restrict' }),
    /**
     * ⭐ **What the goods COST the commissary when they left the shelf** — written by the
     * dispatch, read back by the receipt.
     *
     * ⛔ It is not the transfer value and must never be confused with `rate`. `1340 Inventory in
     * transit` is debited at this figure and must be relieved at it; the difference between it and
     * the transfer value is the commissary's processing work, which goes to `5175` and only for
     * the goods that actually arrive. Debiting `1340` at cost and crediting it at the transfer
     * rate leaves the account permanently negative by exactly that margin — once per shipment,
     * with a trial balance that still ties. See `0071`'s header.
     */
    dispatchCost: numeric('dispatch_cost', { precision: 14, scale: 2 }),
    /**
     * ⭐ T-175. What the low-stock auto-order proposed, as opposed to what the branch settled on.
     *
     * ⚠️ **v1 queues the line at quantity ZERO**; `docs/discovery/14` §D asks whether that is used
     * or whether it just clutters drafts with lines nobody fills in. A zero-quantity line is a
     * to-do item wearing an order line's clothes, so v2 arrives with `threshold − onHand` rounded
     * up — one keystroke fewer than typing into a blank.
     *
     * ⛔ **Written once at append and never refreshed.** It is a record of what was suggested, not
     * a second stored balance: a number that silently changes under somebody filling in a form is
     * worse than a stale one.
     */
    suggestedQuantity: numeric('suggested_quantity', { precision: 14, scale: 3 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('trade_order_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    check('trade_order_lines_rate_non_negative_check', sql`${t.rate} >= 0`),
    check('trade_order_lines_total_positive_check', sql`${t.lineTotal} > 0`),
    check('trade_order_lines_dispatch_cost_check', sql`${t.dispatchCost} is null or ${t.dispatchCost} >= 0`),
    check('trade_order_lines_suggested_quantity_check', sql`${t.suggestedQuantity} is null or ${t.suggestedQuantity} > 0`),
    /** ⭐ One line per item per INTERNAL order — what makes the auto-append idempotent. */
    uniqueIndex('trade_order_lines_internal_item_key')
      .on(t.orderId, t.itemId)
      .where(sql`${t.requestedQuantity} is not null`),
    check('trade_order_lines_origin_check', sql`${t.origin} in ('requested','commissary_added')`),
    check(
      'trade_order_lines_approval_check',
      sql`${t.approval} in ('not_required','pending','approved','rejected')`,
    ),
    /**
     * ⭐ A line the COMMISSARY added always needs the branch's answer. It lands `pending` and
     * does not let the order reach `confirmed` until the branch approves or rejects it.
     */
    check(
      'trade_order_lines_added_needs_approval_check',
      sql`${t.origin} <> 'commissary_added' or ${t.approval} <> 'not_required'`,
    ),
    index('trade_order_lines_order_idx').on(t.orderId),
    index('trade_order_lines_org_item_idx').on(t.orgId, t.itemId),
  ],
);
