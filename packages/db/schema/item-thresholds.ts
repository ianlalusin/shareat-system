/**
 * Low stock, and the conversation about an order — T-175.
 *
 * ## ⭐ The reorder model is smaller than v1's data model implies
 *
 * ⛔ **`itemReorderPolicies` and `reorderAlerts` are DEAD SCHEMA in v1.** `docs/discovery/14` §D
 * verified it: *"grep across `src/lib/**` and `functions/**` finds zero references to either name
 * anywhere in the codebase."* `01-data-model.md` lists them; nothing uses them. The live mechanism
 * is **one field** — a threshold per store per item — plus a summed-on-read query.
 *
 * ⚠️ **v1's item master also still exposes `reorderPoint` and `reorderQuantity`** on every edit
 * form, and nothing reads either: vestiges of a smart-reorder system that was removed. T-145's
 * `items` correctly has neither, and they are not added back here.
 *
 * ⭐ **There is no cached low-stock list and no alert table.** Low stock is a query over T-161's
 * on-hand compared to this threshold, every time. A stored list is DEF-075 for the tenth time, and
 * it is worse than usual here: a stale alert is indistinguishable from a real one.
 */
import { sql } from 'drizzle-orm';
import { check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { tradeOrders } from './trade';

/**
 * ⭐ Per store, per item — not per location. v1 sums across a store's rooms before comparing, and
 * that is right: a branch with three kilos in the kitchen and one in the stockroom has four kilos,
 * and a per-room threshold would cry low stock while a shelf next door is full.
 */
export const storeItemThresholds = pgTable(
  'store_item_thresholds',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'restrict' }),
    /** ⚠️ Zero is allowed and means *"tell me the moment it runs out"* — not "no threshold". */
    lowStockThreshold: numeric('low_stock_threshold', { precision: 14, scale: 3 }).notNull(),
    setBy: uuid('set_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('store_item_thresholds_key').on(t.storeId, t.itemId),
    check('store_item_thresholds_non_negative_check', sql`${t.lowStockThreshold} >= 0`),
    index('store_item_thresholds_org_idx').on(t.orgId),
    check('store_item_thresholds_low_stock_threshold_finite_check', sql`${t.lowStockThreshold} > '-Infinity'::numeric and ${t.lowStockThreshold} < 'Infinity'::numeric`),
  ],
);

/**
 * ⭐ The conversation that belongs to an order.
 *
 * A discrepancy or a substitution gets discussed somewhere, and in v1 that somewhere was a phone
 * call. ⚠️ **Append-only, and that is the whole value**: it is the audit trail of a commercial
 * conversation between two stores, and an editable audit trail is not one. Enforced by a trigger,
 * the same treatment T-161 gives the stock ledger.
 *
 * ⛔ **No attachments, no read receipts, no notifications.** In-app notification is a separate
 * deferred gap, and bolting a half of it onto this table is how it stops being a trail.
 */
export const tradeOrderMessages = pgTable(
  'trade_order_messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull().references(() => tradeOrders.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    authorId: uuid('author_id').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('trade_order_messages_body_not_blank_check', sql`length(trim(${t.body})) > 0`),
    index('trade_order_messages_order_idx').on(t.orderId, t.createdAt),
  ],
);
