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
 *
 * ## ⭐ Both directions, one table (T-372 S6b / DEF-513)
 *
 * A branch can also COUNT MORE than was dispatched. `confirmReceipt` books only what was sent (the cap) and raises a
 * row with `direction = 'over'` for the excess, so the same day-open block and the same manager decision cover it.
 * An over row posts nothing at receipt; its dispositions are `audit`, `extra_dispatch` (the commissary confirms it
 * really sent more: the extra is booked at both stores in one entry) and `return` (it went back, or the branch
 * recounted: posts nothing). Short rows keep `audit | loss | charge | late_receipt`.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { tradeOrderLines, tradeOrders } from './trade';

export const DISCREPANCY_STATUSES = ['open', 'deferred', 'resolved'] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

export const DISCREPANCY_DIRECTIONS = ['short', 'over'] as const;
export type DiscrepancyDirection = (typeof DISCREPANCY_DIRECTIONS)[number];

export const DISCREPANCY_DISPOSITIONS = ['audit', 'loss', 'charge', 'late_receipt', 'extra_dispatch', 'return'] as const;
export type DiscrepancyDisposition = (typeof DISCREPANCY_DISPOSITIONS)[number];

/** T-343 S6a — presentation label, exhaustive over `DISCREPANCY_DISPOSITIONS`. */
export const DISCREPANCY_DISPOSITION_LABEL: Readonly<Record<DiscrepancyDisposition, string>> = {
  audit: 'Audit only',
  loss: 'Loss',
  charge: 'Charged to a person',
  late_receipt: 'Late receipt',
  extra_dispatch: 'Commissary sent more — book the extra',
  return: 'Returned to commissary / branch recount',
};

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Total: `Object.hasOwn` so `'constructor'` never returns a prototype member. */
export function discrepancyDispositionLabel(value: string): string {
  return Object.hasOwn(DISCREPANCY_DISPOSITION_LABEL, value)
    ? DISCREPANCY_DISPOSITION_LABEL[value as DiscrepancyDisposition]
    : humanise(value);
}

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
    /**
     * ⭐ T-372 S6b: the DIRECTION, fixed when the receipt raises the row (`trade_discrepancies_direction_fixed_trg`,
     * migration 0179). `short` — fewer arrived than were sent (every row before 0179). `over` — the branch counted
     * more than was sent. Every disposition rule hangs off it (`trade_discrepancies_disposition_direction_check`).
     */
    direction: text('direction', { enum: DISCREPANCY_DIRECTIONS }).notNull().default('short'),
    /** The difference between dispatched and counted, in base units, always positive: dispatched − received for a
     *  `short` row, counted − dispatched for an `over` row. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /**
     * ⭐ **AT COST — the un-received share of the line's `dispatch_cost`. NOT quantity × the
     * transfer rate.** That is what is actually stranded in `1340 Inventory in transit`, which is
     * debited at cost (`packages/domain/src/commissary/transfer.ts:423-429`); valuing the dispute
     * at the transfer rate would relieve `1340` by more than the goods put into it — DEF-098's
     * hole by a second route.
     *
     * ⚠️ **This comment said "Quantity × the line's transfer rate" from T-174 until 2026-09-05**,
     * describing the opposite of what the code writes. Corrected under DEF-175: T-212's first
     * draft trusted it and derived a received-value cross-check that could never have tied. To
     * reconcile a shortfall against a TRANSFER-rate figure, multiply `quantity` by the LINE's own
     * `rate` — never use this column for that.
     */
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
    // NOTE: 0179 replaced `trade_discrepancies_value_positive_check` (value > 0) with this one: an over row's value is
    // informational and may be 0 (a line whose dispatch cost is 0); a short row's never is.
    check('trade_discrepancies_value_check', sql`${t.value} > 0 or (${t.direction} = 'over' and ${t.value} >= 0)`),
    check('trade_discrepancies_direction_check', sql`${t.direction} in ('short','over')`),
    // NOTE: the `disposition` enum CHECK itself is `trade_discrepancies_disposition_check` (0071, re-added by 0179 with
    // 'extra_dispatch','return'); this one pairs a disposition with its direction (0179).
    check(
      'trade_discrepancies_disposition_direction_check',
      sql`${t.disposition} is null or ${t.disposition} = 'audit' or (${t.direction} = 'short' and ${t.disposition} in ('loss','charge','late_receipt')) or (${t.direction} = 'over' and ${t.disposition} in ('extra_dispatch','return'))`,
    ),
    // NOTE: `trade_discrepancies_direction_fixed_trg` (BEFORE UPDATE OF direction, ENABLE ALWAYS) is hand-added in migration 0179.
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
    check('trade_discrepancies_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    check('trade_discrepancies_value_finite_check', sql`${t.value} > '-Infinity'::numeric and ${t.value} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.chargePersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'trade_discrepancies_charge_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.resolvedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'trade_discrepancies_resolved_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'trade_discrepancies_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'trade_discrepancies_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `order_id` FK (RLS checks only this row's org_id); references `trade_orders_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.orderId],
      foreignColumns: [tradeOrders.orgId, tradeOrders.id],
      name: 'trade_discrepancies_order_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `order_line_id` FK (RLS checks only this row's org_id); references `trade_order_lines_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.orderLineId],
      foreignColumns: [tradeOrderLines.orgId, tradeOrderLines.id],
      name: 'trade_discrepancies_order_line_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
