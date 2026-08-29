/**
 * What happens to the goods that never arrived — T-174.
 *
 * ⭐ **T-173 deliberately does not block a short receipt.** It posts what arrived and leaves the
 * difference sitting in `1340 Inventory in transit` on the commissary's books, because that is what
 * the difference *is*: goods that left one building and did not reach another are a real asset
 * until somebody says otherwise. This table is where somebody says otherwise.
 *
 * ## ⚠️ Why "settle" survives when the machinery around it does not
 *
 * T-173 §3 deletes v1's `pending_variance` two-phase commit and its three admin repair tools —
 * they existed to survive a *transaction* failing halfway across two Firestore stores, and that
 * problem is gone. **But a quantity dispute is a real business event**: the branch says 90 kg
 * arrived, the commissary says it sent 100. That needs a human decision and a posting, and it does
 * not go away because the database got better.
 *
 * ⭐ Keep the capability; delete the plumbing it was bolted to. v1's settle was reached through a
 * failure path; this one is reached through the front door.
 *
 * ## ⭐ The row is created by the confirm, never by hand
 *
 * There is no "raise a discrepancy" action. `confirmReceipt` writes one for every line where
 * received fell short, in the same transaction as the posting — so a shortfall cannot exist in
 * `1340` without a row naming it, and the blocking list below can never disagree with the ledger.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { tradeOrderLines, tradeOrders } from './trade';

export const DISCREPANCY_STATUSES = ['open', 'deferred', 'resolved'] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

export const DISCREPANCY_DISPOSITIONS = ['audit', 'loss', 'charge', 'late_receipt'] as const;
export type DiscrepancyDisposition = (typeof DISCREPANCY_DISPOSITIONS)[number];

export const tradeDiscrepancies = pgTable(
  'trade_discrepancies',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * ⭐ The COMMISSARY's store, and it is stored rather than joined because it is what the
     * day-open block queries on every single sales-day create. ⚠️ Not a derived value in the
     * DEF-075 sense — it is the order's dispatching store, which cannot change.
     */
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull().references(() => tradeOrders.id, { onDelete: 'restrict' }),
    orderLineId: uuid('order_line_id').notNull().references(() => tradeOrderLines.id, { onDelete: 'restrict' }),
    /** Dispatched minus received, in base units. Always positive — an over-receipt is not this. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** Quantity × the line's transfer rate. What is stranded in `1340`. */
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    status: text('status', { enum: DISCREPANCY_STATUSES }).notNull().default('open'),
    disposition: text('disposition', { enum: DISCREPANCY_DISPOSITIONS }),
    /** Who it is being recovered from. ⚠️ `party_type = 'employee'` on the `1230` leg. */
    chargePersonId: uuid('charge_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    /**
     * ⭐ **Exactly once, and that is the whole reason defer is safe to offer.** v1's rule, kept
     * verbatim. A second deferral is refused, which forces a real decision instead of letting a
     * dispute be pushed down the road indefinitely — the state v1's own blocking rule exists to
     * prevent.
     */
    deferredTo: date('deferred_to'),
    note: text('note'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** ⭐ One per order line. A second confirm of the same line cannot raise a second dispute. */
    uniqueIndex('trade_discrepancies_line_key').on(t.orderLineId),
    check('trade_discrepancies_quantity_positive_check', sql`${t.quantity} > 0`),
    check('trade_discrepancies_value_positive_check', sql`${t.value} > 0`),
    check(
      'trade_discrepancies_charge_person_check',
      sql`${t.disposition} <> 'charge' or ${t.chargePersonId} is not null`,
    ),
    /** ⛔ Resolved without saying WHAT it was is the state this table exists to prevent. */
    check(
      'trade_discrepancies_resolved_shape_check',
      sql`${t.status} <> 'resolved' or (${t.disposition} is not null and ${t.resolvedAt} is not null and ${t.resolvedBy} is not null)`,
    ),
    /** A deferral must say until when; anything else must not pretend it was deferred. */
    check(
      'trade_discrepancies_deferred_shape_check',
      sql`(${t.status} = 'deferred') = (${t.deferredTo} is not null)`,
    ),
    /**
     * ⭐ The day-open block's index, and the reason `store_id` is on the row. Partial, because the
     * only rows it ever asks about are the ones that are not finished.
     */
    index('trade_discrepancies_blocking_idx')
      .on(t.storeId, t.status, t.deferredTo)
      .where(sql`${t.status} <> 'resolved'`),
    index('trade_discrepancies_order_idx').on(t.orderId),
  ],
);
