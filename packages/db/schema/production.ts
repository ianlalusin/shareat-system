/**
 * Production — T-176. A slicing run or a prep batch posts as ONE stock transaction: inputs out,
 * outputs in, cost carried across (docs/tasks/176-production-and-prep-conversion.md).
 *
 * ## Two systems share the word "recipe" and they are unrelated (§2)
 *
 * `production_recipes` here is a repeatable prep CONVERSION — ingredient lines with unit
 * conversion, scaled to a target quantity, posting both the consumption and the output stock-in
 * in one action. It has nothing to do with the Phase 7 "cookbook" (photo/video content).
 *
 * ## `production_recipes` / `production_recipe_lines` — CONFIGURATION (cutover: KEEP)
 *
 * A recipe is a standing instruction ("this is how we cut a slab"), not a transaction — the same
 * class as `expense_categories` or `sales_channels`.
 *
 * ## `production_records` / `production_record_lines` — OPERATIONAL (cutover: PURGE)
 *
 * A record is one real conversion event, the same class as `stock_movements` and
 * `journal_entries`. `revision` is the edit-in-place counter (invariant 8): editing a POSTED
 * record inserts NEW lines for the new revision and stamps `reversed_at` on the old ones, which
 * stay visible — never a delete, never an UPDATE of the old row's quantity.
 *
 * ## §7's decision — the slicer-payment lock lives HERE, as a derived query
 *
 * Not a column on this table (⛔ DEF-075's pattern), and not a call Phase 5 makes into inventory.
 * See `packages/domain/src/production/index.ts`'s `hasLiveSlicerPaymentCovering` — the predicate
 * is written now, with Phase 5's payment table stubbed, so the coupling point is designed rather
 * than discovered.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';

export const PRODUCTION_RECIPE_STATUSES = ['active', 'inactive'] as const;
export type ProductionRecipeStatus = (typeof PRODUCTION_RECIPE_STATUSES)[number];

export const productionRecipes = pgTable(
  'production_recipes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    outputItemId: uuid('output_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    outputQuantity: numeric('output_quantity', { precision: 14, scale: 3 }).notNull(),
    status: text('status', { enum: PRODUCTION_RECIPE_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('production_recipes_org_name_key').on(t.orgId, sql`lower(${t.name})`),
    check('production_recipes_output_quantity_positive_check', sql`${t.outputQuantity} > 0`),
    index('production_recipes_org_idx').on(t.orgId),
    check('production_recipes_output_quantity_finite_check', sql`${t.outputQuantity} > '-Infinity'::numeric and ${t.outputQuantity} < 'Infinity'::numeric`),
  ],
);

/** Line quantity/unit — converted against the ITEM's own base unit at cook time
 *  (`unit-conversion.ts`), never snapshotted as an assumed match (DEF-093). */
export const productionRecipeLines = pgTable(
  'production_recipe_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => productionRecipes.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('production_recipe_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    index('production_recipe_lines_recipe_idx').on(t.recipeId),
    index('production_recipe_lines_item_idx').on(t.itemId),
    check('production_recipe_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
  ],
);

export const PRODUCTION_KINDS = ['slice', 'cook', 'convert'] as const;
export type ProductionKind = (typeof PRODUCTION_KINDS)[number];

export const PRODUCTION_STATUSES = ['draft', 'posted', 'void'] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

export const productionRecords = pgTable(
  'production_records',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: PRODUCTION_KINDS }).notNull(),
    recipeId: uuid('recipe_id').references(() => productionRecipes.id, { onDelete: 'restrict' }),
    status: text('status', { enum: PRODUCTION_STATUSES }).notNull().default('draft'),
    /** ⭐ The edit-in-place counter — invariant 8. Starts at 1; a `convert` never moves past it
     *  (editing a convert is refused — invariant 8's own exclusion). */
    revision: integer('revision').notNull().default(1),
    producedOn: date('produced_on').notNull(),
    /** ⭐ SOFT warnings stamped on the record at post — never promoted to blocks (§4, §10.4). */
    softWarnings: jsonb('soft_warnings').notNull().default(sql`'[]'::jsonb`),
    labourCost: numeric('labour_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Null for a `convert` (invariant 5 — enforced as a CHECK in the migration) and for a
     *  still-draft record. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('production_records_revision_positive_check', sql`${t.revision} > 0`),
    check('production_records_labour_cost_non_negative_check', sql`${t.labourCost} >= 0`),
    check(
      'production_records_posted_shape_check',
      sql`${t.status} <> 'posted' or (${t.postedAt} is not null and ${t.postedBy} is not null)`,
    ),
    check(
      'production_records_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)`,
    ),
    // ⭐ Invariant 5, as a constraint: a `convert` never carries a journal entry.
    check('production_records_convert_no_journal_check', sql`${t.kind} <> 'convert' or ${t.journalEntryId} is null`),
    index('production_records_store_status_idx').on(t.storeId, t.status, t.producedOn),
    index('production_records_org_idx').on(t.orgId),
    check('production_records_labour_cost_finite_check', sql`${t.labourCost} > '-Infinity'::numeric and ${t.labourCost} < 'Infinity'::numeric`),
  ],
);

export const PRODUCTION_LINE_DIRECTIONS = ['in', 'out'] as const;
export type ProductionLineDirection = (typeof PRODUCTION_LINE_DIRECTIONS)[number];

export const productionRecordLines = pgTable(
  'production_record_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    recordId: uuid('record_id')
      .notNull()
      .references(() => productionRecords.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: PRODUCTION_LINE_DIRECTIONS }).notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit').notNull(),
    movementId: uuid('movement_id').references(() => stockMovements.id, { onDelete: 'restrict' }),
    /** ⚠️ Mirrors the RECORD's revision at the time this line was written — an edit inserts new
     *  lines rather than mutating old ones (invariant 8). */
    revision: integer('revision').notNull().default(1),
    /** Set when an edit or a void gives this line's stock effect back. The row stays — invariant
     *  8: "the old legs remain visible and marked reversed." */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('production_record_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    check('production_record_lines_revision_positive_check', sql`${t.revision} > 0`),
    index('production_record_lines_record_idx').on(t.recordId),
    index('production_record_lines_item_idx').on(t.itemId),
    check('production_record_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
  ],
);
