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
 * ## §7's decision — the slicer-payment lock (superseded by T-635, migration 0279)
 *
 * It was a stub for a payment table that was never built. T-635 pays the slicer through the pay run, so the lock is now the
 * record's own `paid_by_pay_run_id` (the same idea as `attendance_days.frozen_by_pay_run_id`): set when a posted run pays the
 * record, cleared when that run is voided. `hasLiveSlicerPaymentCovering` in `production/index.ts` reads it.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { payRuns } from './payroll';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';

export const PRODUCTION_RECIPE_STATUSES = ['active', 'inactive'] as const;
export type ProductionRecipeStatus = (typeof PRODUCTION_RECIPE_STATUSES)[number];

/** T-650 S3, migration 0291: a PRODUCT recipe makes a stock item; a KITCHEN recipe (the cookbook) is how to cook a dish we do not stock. */
export const PRODUCTION_RECIPE_PURPOSES = ['product', 'kitchen'] as const;
export type ProductionRecipePurpose = (typeof PRODUCTION_RECIPE_PURPOSES)[number];

export const productionRecipes = pgTable(
  'production_recipes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Null only for a kitchen recipe (migration 0291: `purpose = 'kitchen' or output_item_id is not null`). */
    outputItemId: uuid('output_item_id').references(() => items.id, { onDelete: 'restrict' }),
    /** T-650 S3, migration 0291. */
    purpose: text('purpose', { enum: PRODUCTION_RECIPE_PURPOSES }).notNull().default('product'),
    /** T-650 S3, migration 0291: the steps of a recipe, plain text, at most 4000 characters. */
    method: text('method'),
    /** Product recipe: what one batch makes. Kitchen recipe: "makes N portions". */
    outputQuantity: numeric('output_quantity', { precision: 14, scale: 3 }).notNull(),
    /** T-650 S2, migration 0290: the labour for ONE batch of `outputQuantity`; null = none. A cook with a blank labour box takes this scaled to the quantity made. */
    standardLabourCost: numeric('standard_labour_cost', { precision: 14, scale: 2 }),
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
    check('production_recipes_purpose_check', sql`${t.purpose} in ('product', 'kitchen')`),
    check('production_recipes_output_by_purpose_check', sql`${t.purpose} = 'kitchen' or ${t.outputItemId} is not null`),
    check('production_recipes_method_length_check', sql`${t.method} is null or char_length(${t.method}) <= 4000`),
    check('production_recipes_standard_labour_cost_check', sql`${t.standardLabourCost} is null or ${t.standardLabourCost} >= 0`),
    check('production_recipes_standard_labour_cost_finite_check', sql`${t.standardLabourCost} > '-Infinity'::numeric and ${t.standardLabourCost} < 'Infinity'::numeric`),
    check('production_recipes_output_quantity_finite_check', sql`${t.outputQuantity} > '-Infinity'::numeric and ${t.outputQuantity} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'production_recipes_created_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `output_item_id` FK (RLS checks only this row's org_id); references `items_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.outputItemId],
      foreignColumns: [items.orgId, items.id],
      name: 'production_recipes_output_item_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * T-650 S2, migration 0290 - the stores a PRODUCT recipe may be made at. No rows = every store (back-compatible); rows = only those stores
 * (`createProductionDraft` refuses elsewhere). Both FKs are same-org composites, so a store of another organisation is refused by the database.
 * NOTE: the two composite FKs reference `production_recipes_org_id_id_unique` (migration 0196) and `stores_org_id_id_unique` (migration 0194), and RLS
 * (ENABLE + FORCE + the org_isolation policy) is hand-added in migration 0290.
 */
export const productionRecipeStores = pgTable(
  'production_recipe_stores',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    recipeId: uuid('recipe_id').notNull(),
    storeId: uuid('store_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.recipeId, t.storeId], name: 'production_recipe_stores_pkey' }),
    foreignKey({ columns: [t.orgId, t.recipeId], foreignColumns: [productionRecipes.orgId, productionRecipes.id], name: 'production_recipe_stores_recipe_same_org_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'production_recipe_stores_store_same_org_fk' }).onDelete('restrict'),
    index('production_recipe_stores_store_idx').on(t.storeId),
    index('production_recipe_stores_org_idx').on(t.orgId),
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
    /** T-635 (migration 0279). Who sliced it. Required to POST a slice record (the domain checks they hold Slicer at the store on `produced_on`); null on convert and cook. */
    performedByPersonId: uuid('performed_by_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    /** T-635. Another staff member checked the work. Never the slicer (CHECK below); cleared by an edit; the pay run reads only confirmed records. */
    confirmedByPersonId: uuid('confirmed_by_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** T-635. The posted pay run that paid this record's slicer pay. Set when the run posts, cleared when it is voided; while set the record cannot be edited or voided. */
    paidByPayRunId: uuid('paid_by_pay_run_id').references(() => payRuns.id, { onDelete: 'restrict' }),
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
    // T-635 (migration 0279): confirmation is a pair, never by the slicer; paid means confirmed and still posted.
    check('production_records_confirmed_pair_check', sql`(${t.confirmedByPersonId} is null) = (${t.confirmedAt} is null)`),
    check(
      'production_records_confirmer_not_slicer_check',
      sql`${t.confirmedByPersonId} is null or ${t.performedByPersonId} is null or ${t.confirmedByPersonId} <> ${t.performedByPersonId}`,
    ),
    check('production_records_paid_shape_check', sql`${t.paidByPayRunId} is null or (${t.confirmedAt} is not null and ${t.status} = 'posted')`),
    index('production_records_paid_run_idx').on(t.paidByPayRunId),
    index('production_records_store_status_idx').on(t.storeId, t.status, t.producedOn),
    index('production_records_org_idx').on(t.orgId),
    check('production_records_labour_cost_finite_check', sql`${t.labourCost} > '-Infinity'::numeric and ${t.labourCost} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'production_records_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.postedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'production_records_posted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'production_records_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'production_records_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'production_records_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `location_id` FK (RLS checks only this row's org_id); references `stock_locations_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.locationId],
      foreignColumns: [stockLocations.orgId, stockLocations.id],
      name: 'production_records_location_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `recipe_id` FK (RLS checks only this row's org_id); references `production_recipes_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.recipeId],
      foreignColumns: [productionRecipes.orgId, productionRecipes.id],
      name: 'production_records_recipe_id_same_org_fk',
    }).onDelete('restrict'),
    // T-635 (migration 0279): same-org twins of the three new FKs.
    foreignKey({
      columns: [t.orgId, t.performedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'production_records_performed_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.confirmedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'production_records_confirmed_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.paidByPayRunId],
      foreignColumns: [payRuns.orgId, payRuns.id],
      name: 'production_records_paid_by_pay_run_same_org_fk',
    }).onDelete('restrict'),
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
    /** T-635 (migration 0279). Only an OUTPUT line of a slice record counts toward the slicer's pay, and only while this is true. False = a re-cut or trimming the slicer is not paid for. */
    isPaid: boolean('is_paid').notNull().default(true),
  },
  (t) => [
    check('production_record_lines_quantity_positive_check', sql`${t.quantity} > 0`),
    check('production_record_lines_revision_positive_check', sql`${t.revision} > 0`),
    index('production_record_lines_record_idx').on(t.recordId),
    index('production_record_lines_item_idx').on(t.itemId),
    check('production_record_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
  ],
);
