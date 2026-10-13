/**
 * Stock transfers between two rooms of ONE store — T-167.
 *
 * ## ⭐ Why this table posts nothing
 *
 * A FIFO layer is per STORE, not per location (T-162 invariant 6). A room-to-room transfer
 * therefore moves quantity only — two `stock_movements` rows, no layer consumption, no journal
 * entry. Nothing about the cost of the goods changed because they crossed a doorway. See T-167 §2.
 *
 * ⚠️ A transfer between two STORES is a different thing entirely and it does post — T-173.
 *
 * ## The reservation, and why it is destination-side
 *
 * A two-step transfer's dispatch leg locks the source and writes an OUT movement immediately, but
 * the goods are not yet ON HAND at the destination — they are "in the truck". `stock_reservations`
 * makes that state visible and queryable rather than invisible between dispatch and receive,
 * shipped in v1 2026-07-03 as a preventive control after goods went briefly unaccounted for.
 *
 * `released_at` is set EXACTLY ONCE, by whichever of receive or void resolves it first — never
 * both. The repo enforces this with a conditional UPDATE (`WHERE released_at IS NULL`), the same
 * shape as `count_sessions_commit_once`: a second release affects zero rows rather than firing an
 * exception, so a void that runs after a receive is a no-op on the reservation, not a refusal.
 *
 * ## The composite FK, and why it exists
 *
 * Invariant 1 requires BOTH "the two locations differ" and "the two locations belong to the
 * transfer's own store" to be database checks, not application checks. The first is a plain CHECK.
 * The second needs a cross-table fact a CHECK cannot see, so `stock_locations` gains a
 * `UNIQUE (id, store_id)` and both location columns here are composite-FK'd against it — the
 * standard Postgres idiom for "this row's location belongs to this row's store," enforced without
 * a trigger.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
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

export const TRANSFER_MODES = ['immediate', 'two_step'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

/** ⭐ `in_transit` exists for `two_step` only — `immediate` never persists it (invariant 4). */
export const TRANSFER_STATUSES = ['draft', 'in_transit', 'received', 'void'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    fromLocationId: uuid('from_location_id').notNull(),
    toLocationId: uuid('to_location_id').notNull(),
    mode: text('mode', { enum: TRANSFER_MODES }).notNull(),
    status: text('status', { enum: TRANSFER_STATUSES }).notNull().default('draft'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    dispatchedBy: uuid('dispatched_by').references(() => persons.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: uuid('received_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_transfers_locations_differ_check', sql`${t.fromLocationId} <> ${t.toLocationId}`),
    // ⭐ Invariant 4 as a constraint: `immediate` mode is never observed sitting `in_transit`.
    check(
      'stock_transfers_immediate_never_in_transit_check',
      sql`${t.mode} <> 'immediate' or ${t.status} in ('received','void')`,
    ),
    check(
      'stock_transfers_dispatched_shape_check',
      sql`(${t.dispatchedAt} is null) = (${t.dispatchedBy} is null)`,
    ),
    check(
      'stock_transfers_received_shape_check',
      sql`(${t.receivedAt} is null) = (${t.receivedBy} is null)`,
    ),
    // ⭐ A transfer sitting `in_transit` or `received` must actually carry the timestamp that got
    // it there — same shape as `deliveries_received_shape_check`.
    check(
      'stock_transfers_dispatched_when_in_transit_check',
      sql`${t.status} not in ('in_transit','received') or ${t.dispatchedAt} is not null`,
    ),
    check(
      'stock_transfers_received_when_received_check',
      sql`${t.status} <> 'received' or ${t.receivedAt} is not null`,
    ),
    check(
      'stock_transfers_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)`,
    ),
    // ⭐ The composite FKs that make invariant 1's "same store" half a database fact — see header.
    foreignKey({
      columns: [t.fromLocationId, t.storeId],
      foreignColumns: [stockLocations.id, stockLocations.storeId],
      name: 'stock_transfers_from_location_store_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.toLocationId, t.storeId],
      foreignColumns: [stockLocations.id, stockLocations.storeId],
      name: 'stock_transfers_to_location_store_fk',
    }).onDelete('restrict'),
    index('stock_transfers_store_status_idx').on(t.storeId, t.status),
    index('stock_transfers_org_idx').on(t.orgId),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_transfers_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.dispatchedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_transfers_dispatched_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.receivedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_transfers_received_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'stock_transfers_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_transfers_voided_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'cascade' }),
    lineNo: text('line_no').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** Set at dispatch. */
    outMovementId: uuid('out_movement_id').references(() => stockMovements.id, { onDelete: 'restrict' }),
    /** Set at receive. */
    inMovementId: uuid('in_movement_id').references(() => stockMovements.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_transfer_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    uniqueIndex('stock_transfer_lines_transfer_line_key').on(t.transferId, t.lineNo),
    index('stock_transfer_lines_item_idx').on(t.itemId),
    check('stock_transfer_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
  ],
);

/**
 * Destination-side, dispatch-set, receive-or-void-resolved. See header.
 *
 * ⛔ Never queried by `onHand` — invariant 6. "In the truck" is a separate, visible number, never
 * netted into on-hand.
 */
export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'restrict' }),
    /** Set once, by receive OR by void, never both. A second release is a no-op UPDATE, not an error. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_reservations_quantity_positive_check', sql`${t.quantity} > 0`),
    uniqueIndex('stock_reservations_transfer_item_key').on(t.transferId, t.itemId),
    foreignKey({
      columns: [t.locationId, t.storeId],
      foreignColumns: [stockLocations.id, stockLocations.storeId],
      name: 'stock_reservations_location_store_fk',
    }).onDelete('restrict'),
    index('stock_reservations_item_location_idx').on(t.itemId, t.locationId),
    index('stock_reservations_org_idx').on(t.orgId),
    check('stock_reservations_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'stock_reservations_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
