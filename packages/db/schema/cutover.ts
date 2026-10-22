/**
 * The 31 December conversion — where the wizard remembers itself. T-134.
 *
 * ⛔ **There is no `REHEARSAL` flag here, and that is deliberate.** ADR-007 already provides the
 * isolation the November rehearsal needs — the real software against a restored database. *A flag
 * is a marker a code path can forget to set*, and a forgotten one produces a rehearsal attestation
 * indistinguishable from a real one. **The restored database cannot forget what it is.**
 */
import { sql } from 'drizzle-orm';
import { check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stores } from './stores';

export const STEP_COMPLETIONS = ['verified', 'attested', 'performed'] as const;
export type StepCompletion = (typeof STEP_COMPLETIONS)[number];

export const cutoverSteps = pgTable(
  'cutover_steps',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * Null for an org-wide step. ⭐ A per-store step gets one row PER STORE, deliberately: a single
     * tick across four stores hides the store nobody visited.
     */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    stepCode: text('step_code').notNull(),
    /**
     * ⚠️ The three are NOT interchangeable on screen. An attestation renders as *"Recorded by Ian,
     * 31 Dec 22:14 — not machine-verifiable"*; a green tick identical to a verified one would be
     * dishonest. No system studied does better on a physical count either — ERPNext's own
     * opening-stock reconciliation still takes a human-typed quantity. We are not behind the
     * field here; the field has the same limit.
     */
    completion: text('completion', { enum: STEP_COMPLETIONS }).notNull(),
    note: text('note'),
    completedBy: uuid('completed_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cutover_steps_step_store_key').on(
      t.orgId,
      t.stepCode,
      sql`coalesce(${t.storeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.completedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'cutover_steps_completed_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'cutover_steps_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * The counted stock — step B3, and the input to C3's inventory opening figures.
 *
 * ⭐ **An item silently absent is indistinguishable from an item counted as zero**, so a zero is
 * stored explicitly and the check asks for a row per active item rather than a non-zero total.
 */
export const openingCounts = pgTable(
  'opening_counts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    // NOTE: trigger hand-added in migration 0191 (opening_counts_room_in_store: the room must be a room of store_id).
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** Zero is a real, meaningful answer and must be storable. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** Null until the count is valued. C3 lists these as gaps, by name. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
    /** T-390 R2: where the cost came from ('typed', 'v1_last_delivery', ...). Null together with unit_cost. */
    costSource: text('cost_source'),
    costEvidence: text('cost_evidence'),
    note: text('note'),
    countedBy: uuid('counted_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('opening_counts_quantity_non_negative_check', sql`${t.quantity} >= 0`),
    check('opening_counts_unit_cost_non_negative_check', sql`${t.unitCost} is null or ${t.unitCost} >= 0`),
    uniqueIndex('opening_counts_store_location_item_key').on(t.storeId, t.locationId, t.itemId),
    index('opening_counts_location_idx').on(t.locationId),
    check('opening_counts_cost_source_pair_check', sql`(${t.unitCost} is null) = (${t.costSource} is null)`),
    check('opening_counts_cost_source_not_blank_check', sql`${t.costSource} is null or length(trim(${t.costSource})) > 0`),
    index('opening_counts_org_idx').on(t.orgId),
    check('opening_counts_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    check('opening_counts_unit_cost_finite_check', sql`${t.unitCost} > '-Infinity'::numeric and ${t.unitCost} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.countedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'opening_counts_counted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'opening_counts_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `item_id` FK (RLS checks only this row's org_id); references `items_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.itemId],
      foreignColumns: [items.orgId, items.id],
      name: 'opening_counts_item_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `location_id` FK (RLS checks only this row's org_id); references `stock_locations_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.locationId],
      foreignColumns: [stockLocations.orgId, stockLocations.id],
      name: 'opening_counts_location_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
