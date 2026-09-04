/**
 * order_wastages + order_wastage_allocations — T-178.
 * docs/tasks/178-channel-wastage-disposition.md.
 *
 * ## ⚠️ Read this before touching either table: this is NOT stock wastage
 *
 * Two unrelated systems share the word "wastage". T-168's `stock_usage_records` decrements a
 * FIFO layer at cost — raw ingredients, spoiled or damaged. **This module is order-economics: a
 * refunded Foodpanda order, a dine-in dish remade.** It writes NO stock movement and consumes NO
 * layer — a reviewer who finds this touching `stock_layers` or `stock_movements` has found the
 * two systems conflated, which is exactly the trap the spec warns against (§1).
 *
 * ## Instant vs tracked (§3)
 *
 * `type_mode = 'instant'` books straight to `resolved` — the disposition is decided the moment
 * the row is written, in the same call. `type_mode = 'tracked'` (channel orders) is created
 * `open`, with a responsible party already seeded (invariant 2), and awaits a human decision —
 * disputed, resolved by hand, matched against a settlement, or closed by the 15-day backstop.
 *
 * ## `1220` is the credit in every case that posts (§6)
 *
 * The order was recognised as revenue with a channel receivable behind it (T-123); a wastage
 * answers who ends up bearing it. `platform_paid` posts nothing — T-150's settlement already
 * clears `1220` for the day. ⚠️ Not `1210` — a diner is not a customer (ADR-008 §11).
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelSettlements } from './channel-settlements';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { salesDays } from './sales-days';
import { stores } from './stores';

export const ORDER_WASTAGE_TYPE_MODES = ['instant', 'tracked'] as const;
export type OrderWastageTypeMode = (typeof ORDER_WASTAGE_TYPE_MODES)[number];

export const ORDER_WASTAGE_STATUSES = ['open', 'disputed', 'resolved'] as const;
export type OrderWastageStatus = (typeof ORDER_WASTAGE_STATUSES)[number];

/**
 * ⚠️ Three values, exactly the schema contract's own enum (§7) — NOT four. §6's posting table
 * also names a "Split" row ("Both of the above, for their respective shares"), but invariant 3
 * requires allocation percentages to sum to EXACTLY 100 whenever any exist, which leaves no room
 * for a partial store-absorbed remainder inside one resolution. Read literally, "split" is the
 * multi-person case of `charged` — several people, each charged their own allocated share of the
 * SAME disposition — not a fourth disposition value. See the T-178 task report for this reading.
 */
export const ORDER_WASTAGE_DISPOSITIONS = ['platform_paid', 'absorbed', 'charged'] as const;
export type OrderWastageDisposition = (typeof ORDER_WASTAGE_DISPOSITIONS)[number];

export const orderWastages = pgTable(
  'order_wastages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    salesDayId: uuid('sales_day_id')
      .notNull()
      .references(() => salesDays.id, { onDelete: 'restrict' }),
    /**
     * ⚠️ Free text, not a FK — `grab | foodpanda | dine_in | ...`, per the contract. Resolved to
     * a real `sales_channels` row (by org+store+name) at POSTING time only, because that is the
     * one moment a party is actually needed for the `1220` leg — see `wastage/orders.ts`'s
     * `resolveChannelParty`. A store with no matching channel configured is refused there, by
     * name, rather than silently posting without a party (which the DB would refuse anyway).
     */
    channel: text('channel').notNull(),
    /** The platform's own order id. Null for a dine-in remake, which has none. */
    orderRef: text('order_ref'),
    typeMode: text('type_mode', { enum: ORDER_WASTAGE_TYPE_MODES }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ORDER_WASTAGE_STATUSES }).notNull().default('open'),
    disposition: text('disposition', { enum: ORDER_WASTAGE_DISPOSITIONS }),
    /** ⭐ Set the moment the 15-day backstop decides instead of a human — invariant 6. */
    autoCharged: boolean('auto_charged').notNull().default(false),
    /** T-150's settlement this was matched and confirmed against, if any (§4). Provenance only —
     *  set regardless of which disposition the human ultimately chose. */
    settlementId: uuid('settlement_id').references(() => channelSettlements.id, { onDelete: 'restrict' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    /** ⭐ The 15-day clock's own anchor (invariant 4) — set at creation, UNCHANGED by a dispute. */
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('order_wastages_amount_positive_check', sql`${t.amount} > 0`),
    check('order_wastages_type_mode_check', sql`${t.typeMode} in ('instant', 'tracked')`),
    check('order_wastages_status_check', sql`${t.status} in ('open', 'disputed', 'resolved')`),
    check(
      'order_wastages_disposition_check',
      sql`${t.disposition} is null or ${t.disposition} in ('platform_paid', 'absorbed', 'charged')`,
    ),
    /** ⛔ Resolved without saying WHAT it was is the state the trade_discrepancies precedent
     *  (T-174) already refuses, and this table refuses it the same way. */
    check('order_wastages_resolved_shape_check', sql`${t.status} <> 'resolved' or ${t.disposition} is not null`),
    index('order_wastages_org_store_status_idx').on(t.orgId, t.storeId, t.status),
    index('order_wastages_sales_day_idx').on(t.salesDayId),
    /** The backstop's own query: unresolved rows, oldest first, regardless of status. */
    index('order_wastages_backstop_idx').on(t.status, t.openedAt),
  ],
);

export const orderWastageAllocations = pgTable(
  'order_wastage_allocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    wastageId: uuid('wastage_id')
      .notNull()
      .references(() => orderWastages.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    percent: numeric('percent', { precision: 5, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('order_wastage_allocations_wastage_person_unique').on(t.wastageId, t.personId),
    check('order_wastage_allocations_percent_check', sql`${t.percent} > 0 and ${t.percent} <= 100`),
    /** ⭐ Invariant 3 — percentages summing to exactly 100 whenever any exist — is a CROSS-ROW
     *  rule a single-row CHECK cannot express. It is a deferred constraint trigger, migration-only
     *  (`order_wastage_allocations_sum_100_trg`); nothing to declare on this Drizzle table. */
  ],
);
