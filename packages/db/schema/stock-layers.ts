/**
 * FIFO cost layers — T-162's storage half. What the stock on the shelf actually cost.
 *
 * ⭐ **A delivery already IS a cost layer** — quantity, unit cost, one receipt (ADR-009 §1). So
 * FIFO is not bolted on to this business; it is how the business already records purchases, and
 * this table maps v1's shape rather than replacing it. Bible row 110 chose FIFO on physical
 * grounds: food is perishable and actually moves first-in-first-out.
 *
 * ## Two grains, and confusing them is the trap
 *
 * ⚠️ **A LAYER is per item per STORE. A MOVEMENT is per item per LOCATION** (T-161). So moving
 * stock between two rooms of one store consumes no layer and posts no cost — which is why T-167's
 * transfers are cheap, and why `stock_layers` carries `store_id` and not `location_id`.
 *
 * ## What is deliberately absent
 *
 * ⛔ **No running weighted-average column.** v1 has one — `items.costPerUnit` — and it is **zero on
 * 595 of 842 items (71%)**: a snapshot nobody maintained. ⭐ The one weighted average that survives
 * is the 2027-01-01 opening layer, because that is what the counted data supports and a single
 * opening layer at an average cost is the standard way to open FIFO books (ADR-009). **The basis
 * changes exactly once, at the boundary, by design.**
 *
 * ⛔ **No negative layers and no "vacuum" correction.** Odoo solves consuming-more-than-you-have
 * with a whole subsystem; here a shortfall is REFUSED (`planConsumption` returns `ok: false`), and
 * refusing it is the deliberate simplification discovery 20 recommended.
 *
 * ⛔ **No `remaining_value` column.** It is `remaining_quantity × unit_cost` and would be a second
 * copy of a number the row already holds — DEF-075's pattern, declined. Odoo stores it; we do not.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { items } from './items';
import { organizations } from './organizations';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';
import { supplierInvoiceLines } from './items';

/** Where a layer's stock came from. `opening` is the 2027-01-01 weighted-average layer. */
export const LAYER_SOURCES = ['delivery', 'transfer_in', 'production', 'opening', 'count'] as const;
export type LayerSource = (typeof LAYER_SOURCES)[number];

export const stockLayers = pgTable(
  'stock_layers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⚠️ Per STORE, never per location — see this file's header. */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** ⭐ The FIFO ordering key. Ties break by `id`, so the order is total and reproducible. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** As received, in BASE units. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** Landed cost per BASE unit — T-151 allocates the inbound fee into this. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
    /** Decremented as the layer is consumed. Never negative, never above `quantity`. */
    remainingQuantity: numeric('remaining_quantity', { precision: 14, scale: 3 }).notNull(),
    source: text('source', { enum: LAYER_SOURCES }).notNull(),
    sourceId: uuid('source_id').notNull(),
    /** The `receipt` movement that created this layer — one layer per stock-in. */
    movementId: uuid('movement_id')
      .notNull()
      .references(() => stockMovements.id, { onDelete: 'restrict' }),
    /**
     * ⭐ **A fact about the COST, never about the quantity.** A provisional layer is fully
     * consumable; only its `unit_cost` is subject to correction when the supplier invoice arrives
     * (T-163). ⛔ It is not a stored flag somebody sets — it is false exactly when
     * `invoice_line_id` is present, and the CHECK below makes the two agree by construction.
     */
    isProvisional: boolean('is_provisional').notNull().default(true),
    invoiceLineId: uuid('invoice_line_id').references(() => supplierInvoiceLines.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('stock_layers_quantity_positive_check', sql`${t.quantity} > 0`),
    check('stock_layers_unit_cost_non_negative_check', sql`${t.unitCost} >= 0`),
    /** ⭐ The constraint that makes a planner bug a failed transaction rather than a wrong number. */
    check(
      'stock_layers_remaining_within_bounds_check',
      sql`${t.remainingQuantity} >= 0 and ${t.remainingQuantity} <= ${t.quantity}`,
    ),
    /** `is_provisional` and `invoice_line_id` are two views of one fact; they may not disagree. */
    check(
      'stock_layers_provisional_matches_invoice_check',
      sql`${t.isProvisional} = (${t.invoiceLineId} is null)`,
    ),
    /** One layer per stock-in movement. A retried receipt cannot double the cost basis. */
    uniqueIndex('stock_layers_movement_key').on(t.movementId),
    /** The consumption query: open layers for an item in a store, oldest first. */
    index('stock_layers_open_idx')
      .on(t.itemId, t.storeId, t.receivedAt)
      .where(sql`${t.remainingQuantity} > 0`),
    index('stock_layers_org_idx').on(t.orgId),
    check('stock_layers_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    check('stock_layers_unit_cost_finite_check', sql`${t.unitCost} > '-Infinity'::numeric and ${t.unitCost} < 'Infinity'::numeric`),
    check('stock_layers_remaining_quantity_finite_check', sql`${t.remainingQuantity} > '-Infinity'::numeric and ${t.remainingQuantity} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'stock_layers_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `item_id` FK (RLS checks only this row's org_id); references `items_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.itemId],
      foreignColumns: [items.orgId, items.id],
      name: 'stock_layers_item_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `movement_id` FK (RLS checks only this row's org_id); references `stock_movements_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.movementId],
      foreignColumns: [stockMovements.orgId, stockMovements.id],
      name: 'stock_layers_movement_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: stock_layers_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0212 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES stock_layers (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);

/**
 * Which layer paid for which movement — **the inventory subledger.**
 *
 * ⭐ Σ these rows is what the journal entry must equal, or invariant 6's inventory arm breaks.
 * That is why T-162 rounds cost PER LINE rather than on the total: each row here is a real
 * 2-decimal money amount, and the entry is what they sum to.
 *
 * ⚠️ `unit_cost` is SNAPSHOTTED, and that is not a contradiction of "derive, don't store". T-145
 * drew the line and it holds: *a balance is a consequence of facts and must be recomputed, but a
 * cost used in a past transaction **is** a fact.* Re-costing a layer next year must not rewrite
 * what a March COGS posting said.
 */
export const stockLayerConsumptions = pgTable(
  'stock_layer_consumptions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    layerId: uuid('layer_id')
      .notNull()
      .references(() => stockLayers.id, { onDelete: 'restrict' }),
    /** The out-movement this quantity paid for. */
    movementId: uuid('movement_id')
      .notNull()
      .references(() => stockMovements.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
    /** ⭐ The line's money, rounded once, here — never recomputed downstream. */
    cost: numeric('cost', { precision: 14, scale: 2 }).notNull(),
    /** Set when this consumption has been given back (a void, or a customer return — T-179). */
    reversedByMovementId: uuid('reversed_by_movement_id').references(() => stockMovements.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_layer_consumptions_quantity_positive_check', sql`${t.quantity} > 0`),
    /**
     * ⭐ T-179/DEF-128. AT MOST ONE UNREVERSED row per (layer, movement) — a retried consumption
     * still cannot double-relieve a layer, but a PARTIAL reversal now legitimately produces a
     * second row for the same pair: the original shrinks to what remains outstanding, and a new
     * row, already reversed, carries exactly what was given back. `quantity`'s own CHECK forbids
     * a row ever reaching zero, so a full reversal cannot be represented by shrinking — only a
     * partial one can, and only while genuinely unreversed. Same partial-uniqueness shape as
     * `stock_movements_source_pair_key`.
     */
    uniqueIndex('stock_layer_consumptions_layer_movement_key')
      .on(t.layerId, t.movementId)
      .where(sql`${t.reversedByMovementId} is null`),
    index('stock_layer_consumptions_movement_idx').on(t.movementId),
    /** T-179's query: what is still outstanding for a movement, newest consumed first. */
    index('stock_layer_consumptions_outstanding_idx')
      .on(t.movementId)
      .where(sql`${t.reversedByMovementId} is null`),
    check('stock_layer_consumptions_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    check('stock_layer_consumptions_unit_cost_finite_check', sql`${t.unitCost} > '-Infinity'::numeric and ${t.unitCost} < 'Infinity'::numeric`),
    check('stock_layer_consumptions_cost_finite_check', sql`${t.cost} > '-Infinity'::numeric and ${t.cost} < 'Infinity'::numeric`),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `layer_id` FK (RLS checks only this row's org_id); references `stock_layers_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.layerId],
      foreignColumns: [stockLayers.orgId, stockLayers.id],
      name: 'stock_layer_consumptions_layer_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `movement_id` FK (RLS checks only this row's org_id); references `stock_movements_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.movementId],
      foreignColumns: [stockMovements.orgId, stockMovements.id],
      name: 'stock_layer_consumptions_movement_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `reversed_by_movement_id` FK (RLS checks only this row's org_id); references `stock_movements_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.reversedByMovementId],
      foreignColumns: [stockMovements.orgId, stockMovements.id],
      name: 'stock_layer_consumptions_reversed_by_movement_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
