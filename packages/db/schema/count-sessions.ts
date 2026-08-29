/**
 * Physical counts — T-169. The freeze, the count, and the variance that finally posts.
 *
 * ## ⚠️ The near-miss this table is shaped around
 *
 * v1's freeze guard shipped 2026-07-03 and was enforced from day one. `openCountSessionAction`,
 * `setCountSessionStatusAction` and `closeCountSessionAction` had **zero callers in the app for
 * seven weeks** — so nothing could open a session, the guard could never engage, and *"had a
 * session doc ever been created by any other route… the location would have been frozen
 * permanently for non-admins."*
 *
 * ⭐ **A shipped server action is not a shipped feature.** The same lesson cost supplier returns
 * seven weeks too. T-169's `Done when` requires open, advance and close to be exercised from a
 * browser, not from a test.
 *
 * ## ⭐ The gap this closes: v1 posts NO GL entry for a count
 *
 * `stock-count.actions.ts`, in its own words: **"NO GL, v1"**. A fleet-wide shrinkage moved stock
 * and touched the books nowhere. Here a variance posts `5400` at FIFO cost, signed both ways.
 *
 * ⚠️ **One exception, already decided:** an *opening* count posts against `3900`, not `5400` —
 * v2 has no December P&L to charge December's shrinkage to (T-134). This module refuses
 * `kind='opening'` and names it.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';

/**
 * ⭐ `open` and `counting` and `reviewing` all FREEZE. Only `closed` and `cancelled` release.
 *
 * The progression exists so a manager can see where a count has got to; the freeze does not care
 * which of the three it is in, because stock must not move while anybody is counting it.
 */
export const COUNT_SESSION_STATUSES = ['open', 'counting', 'reviewing', 'closed', 'cancelled'] as const;
export type CountSessionStatus = (typeof COUNT_SESSION_STATUSES)[number];

/** The three that hold the freeze. Exported because both the trigger and the domain need one list. */
export const FREEZING_STATUSES: readonly CountSessionStatus[] = ['open', 'counting', 'reviewing'];

export const countSessions = pgTable(
  'count_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    status: text('status', { enum: COUNT_SESSION_STATUSES }).notNull().default('open'),
    countedOn: date('counted_on').notNull(),
    note: text('note'),
    /** Set once, at commit. A second commit is refused rather than re-posted. */
    committedAt: timestamp('committed_at', { withTimezone: true }),
    journalEntryId: uuid('journal_entry_id'),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedBy: uuid('closed_by').references(() => persons.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'count_sessions_closed_shape_check',
      sql`${t.status} not in ('closed','cancelled') or (${t.closedAt} is not null and ${t.closedBy} is not null)`,
    ),
    index('count_sessions_store_status_idx').on(t.storeId, t.status),
    index('count_sessions_org_idx').on(t.orgId),
  ],
);

export const countSessionLocations = pgTable(
  'count_session_locations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => countSessions.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
  },
  (t) => [uniqueIndex('count_session_locations_key').on(t.sessionId, t.locationId)],
);

export const countLines = pgTable(
  'count_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => countSessions.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    /** ⭐ Zero is a real, meaningful answer. An item absent is indistinguishable from an item
     *  counted as zero, so a zero is stored explicitly — the same reasoning `opening_counts` uses. */
    countedQuantity: numeric('counted_quantity', { precision: 14, scale: 3 }).notNull(),
    /** ⚠️ Snapshotted AT COMMIT, from the ledger inside the committing transaction. Computing it
     *  earlier makes the variance a comparison against a number that has since moved. */
    expectedQuantity: numeric('expected_quantity', { precision: 14, scale: 3 }),
    variance: numeric('variance', { precision: 14, scale: 3 }),
    movementId: uuid('movement_id').references(() => stockMovements.id, { onDelete: 'restrict' }),
    countedBy: uuid('counted_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('count_lines_session_item_location_key').on(t.sessionId, t.itemId, t.locationId),
    check('count_lines_counted_non_negative_check', sql`${t.countedQuantity} >= 0`),
    index('count_lines_session_idx').on(t.sessionId),
  ],
);
