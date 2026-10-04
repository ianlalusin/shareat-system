/**
 * POS item mapping and the daily usage pull — T-177.
 *
 * A day's POS sales turn into inventory consumption so on-hand stays honest against what was
 * actually sold, instead of drifting until the next physical count explains it as shrinkage
 * (`docs/CAPABILITY-GAPS.md`, `docs/discovery/14` §L).
 *
 * ## `pos_item_maps` / `pos_map_requests` — CONFIGURATION (cutover: KEEP)
 *
 * A map is a standing decision ("this POS item means THIS stock item"), the same class as
 * `expense_categories` or `production_recipes` — nobody wants to re-map a menu on 1 January.
 *
 * ## `pos_usage_pulls` / `pos_usage_pull_lines` — OPERATIONAL (cutover: PURGE)
 *
 * One real reconciliation event per (store, sales day), the same class as `stock_usage_records`.
 *
 * ## ⚠️ Two additions beyond the task doc's own contract table, both reported here rather than
 * silently added (bible §3.4a)
 *
 * 1. **`location_id`, on both `pos_item_maps` (nullable override) and `pos_usage_pulls`
 *    (required default).** The task's contract omits a location entirely, but `stock_usage_records`
 *    (T-168) requires one NOT NULL per document, and a store may have more than one active
 *    `operating` room (T-160 — `role` is not unique per store). v1's own `PosItemMapPlain` carries
 *    exactly this shape: *"Per-item operating-location override. null ⇒ use the pull-level
 *    location... For the 'drinks come from the Display Cabinet, sauces from the Kitchen' case."*
 *    Ported verbatim rather than re-derived, and it is what makes invariant 9's *per-line* freeze
 *    behaviour ("refuses its lines" — plural, some but not all) possible: lines sharing a resolved
 *    location succeed or fail together, and different lines may resolve to different locations.
 * 0. **T-374 S7 (DEF-578, migration 0181): a pull can be voided.** `voided_at`, `voided_by`, `void_reason` record who, when
 *    and why, written only by `voidPosUsagePull` (`domain/src/pos/usage-pull.ts`), which reverses every usage record the
 *    pull made first. `pos_usage_pulls_void_shape_check` refuses `status = 'void'` without all three (and a blank reason).
 * 2. **Three `*_finalized_at` timestamps on `pos_usage_pulls`, plus a stricter uniqueness than
 *    literally stated.** Invariant 4 requires finalize to be idempotent PER SECTION, independent of
 *    whether individual lines within it succeeded (invariant 9's frozen lines are skipped, not
 *    retried) — so "was this section already finalized" cannot be derived from line state alone.
 *    The unique index below is `where status <> 'void'` rather than the literal `where status =
 *    'planned'` invariant 12 states: allowing a SECOND pull once the first is `finalized` risks
 *    double-posting a POS item whose mapping didn't change between the two pulls (the fresh rebuild
 *    would recompute it identically and finalize it a second time). The literal wording's
 *    behaviour — refused while planned — is still exactly what a caller sees; this is a strictly
 *    safer superset, not a contradiction, and is the standard/boring choice over building
 *    cross-pull double-count detection this task does not test for.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
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
import { productionRecipes } from './production';
import { salesDays } from './sales-days';
import { stockLocations } from './stock-locations';
import { stockUsageRecords } from './stock-usage';
import { stores } from './stores';

export const POS_MAP_MODES = ['direct', 'recipe', 'no_stock'] as const;
export type PosMapMode = (typeof POS_MAP_MODES)[number];

export const POS_MAP_STATUSES = ['active', 'inactive'] as const;
export type PosMapStatus = (typeof POS_MAP_STATUSES)[number];

export const posItemMaps = pgTable(
  'pos_item_maps',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** POS's own identifier, verbatim — never re-keyed. */
    posItemKey: text('pos_item_key').notNull(),
    /** As POS calls it, for the picker. Denormalized display only. */
    posItemName: text('pos_item_name').notNull(),
    mode: text('mode', { enum: POS_MAP_MODES }).notNull(),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'restrict' }),
    recipeId: uuid('recipe_id').references(() => productionRecipes.id, { onDelete: 'restrict' }),
    quantityPerSale: numeric('quantity_per_sale', { precision: 14, scale: 6 }),
    /** ⚠️ ADDED — see this file's header. Null = use the pull's own location. */
    locationId: uuid('location_id').references(() => stockLocations.id, { onDelete: 'restrict' }),
    status: text('status', { enum: POS_MAP_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('pos_item_maps_store_key_active_key')
      .on(t.storeId, t.posItemKey)
      .where(sql`${t.status} = 'active'`),
    index('pos_item_maps_org_idx').on(t.orgId),
    index('pos_item_maps_item_idx').on(t.itemId),
    check('pos_item_maps_pos_item_key_not_blank_check', sql`length(trim(${t.posItemKey})) > 0`),
    check(
      'pos_item_maps_mode_shape_check',
      sql`(${t.mode} = 'direct' and ${t.itemId} is not null and ${t.quantityPerSale} is not null)
       or (${t.mode} = 'recipe' and ${t.recipeId} is not null)
       or (${t.mode} = 'no_stock' and ${t.itemId} is null and ${t.recipeId} is null)`,
    ),
    check(
      'pos_item_maps_quantity_per_sale_positive_check',
      sql`${t.quantityPerSale} is null or ${t.quantityPerSale} > 0`,
    ),
    check('pos_item_maps_quantity_per_sale_finite_check', sql`${t.quantityPerSale} > '-Infinity'::numeric and ${t.quantityPerSale} < 'Infinity'::numeric`),
  ],
);

export const POS_MAP_REQUEST_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type PosMapRequestStatus = (typeof POS_MAP_REQUEST_STATUSES)[number];

export const posMapRequests = pgTable(
  'pos_map_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    posItemKey: text('pos_item_key').notNull(),
    posItemName: text('pos_item_name').notNull(),
    note: text('note'),
    status: text('status', { enum: POS_MAP_REQUEST_STATUSES }).notNull().default('requested'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => persons.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
  },
  (t) => [
    // One open request per (store, POS item) at a time — a second "flag" while one is already
    // pending is noise, not new information.
    uniqueIndex('pos_map_requests_store_key_requested_key')
      .on(t.storeId, t.posItemKey)
      .where(sql`${t.status} = 'requested'`),
    index('pos_map_requests_org_status_idx').on(t.orgId, t.status),
    check(
      'pos_map_requests_decided_shape_check',
      sql`${t.status} = 'requested' or (${t.decidedBy} is not null and ${t.decidedAt} is not null)`,
    ),
  ],
);

export const POS_USAGE_PULL_STATUSES = ['planned', 'finalized', 'void'] as const;
export type PosUsagePullStatus = (typeof POS_USAGE_PULL_STATUSES)[number];

export const posUsagePulls = pgTable(
  'pos_usage_pulls',
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
    /** ⚠️ ADDED — see this file's header. The pull-level default operating location. */
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    /** Invariant 3's staleness clock — stamped once, at plan time, never refreshed by finalize's
     *  own live re-fetch. */
    snapshotTakenAt: timestamp('snapshot_taken_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: POS_USAGE_PULL_STATUSES }).notNull().default('planned'),
    /** ⚠️ ADDED — per-section one-shot finalize tracking (invariant 4). See this file's header. */
    directFinalizedAt: timestamp('direct_finalized_at', { withTimezone: true }),
    recipeFinalizedAt: timestamp('recipe_finalized_at', { withTimezone: true }),
    orphanFinalizedAt: timestamp('orphan_finalized_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedBy: uuid('finalized_by').references(() => persons.id, { onDelete: 'restrict' }),
    /** T-374 S7 (DEF-578, migration 0181): who voided the pull, when and why. Mirrors `stock_usage_records`. */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ⚠️ Stricter than the literal spec wording — see this file's header, point 2.
    uniqueIndex('pos_usage_pulls_store_day_live_key')
      .on(t.storeId, t.salesDayId)
      .where(sql`${t.status} <> 'void'`),
    check(
      'pos_usage_pulls_finalized_shape_check',
      sql`${t.status} <> 'finalized' or (${t.finalizedAt} is not null and ${t.finalizedBy} is not null)`,
    ),
    check(
      'pos_usage_pulls_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null and ${t.voidReason} ~ '[^[:space:]]')`,
    ),
    index('pos_usage_pulls_store_status_idx').on(t.storeId, t.status),
    index('pos_usage_pulls_org_idx').on(t.orgId),
  ],
);

export const POS_USAGE_PULL_SECTIONS = ['direct', 'recipe', 'orphan'] as const;
export type PosUsagePullSection = (typeof POS_USAGE_PULL_SECTIONS)[number];

export const posUsagePullLines = pgTable(
  'pos_usage_pull_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    pullId: uuid('pull_id')
      .notNull()
      .references(() => posUsagePulls.id, { onDelete: 'cascade' }),
    section: text('section', { enum: POS_USAGE_PULL_SECTIONS }).notNull(),
    /** ⚠️ ADDED — the stable identity a client confirms against (invariant 2). Deterministic from
     *  (section, posItemKey, and — for a recipe's several ingredient lines — which one). */
    lineKey: text('line_key').notNull(),
    posItemKey: text('pos_item_key').notNull(),
    /** ⚠️ ADDED — display. An orphan line has no `item_id` to look a name up through. */
    posItemName: text('pos_item_name').notNull(),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'restrict' }),
    /** ⚠️ ADDED — this line's RESOLVED location (map override ?? the pull's own). Null for orphan. */
    locationId: uuid('location_id').references(() => stockLocations.id, { onDelete: 'restrict' }),
    /** Null for orphan (nothing to consume) and for a blocked recipe line. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }),
    usageRecordId: uuid('usage_record_id').references(() => stockUsageRecords.id, { onDelete: 'restrict' }),
    blocked: jsonb('blocked'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pos_usage_pull_lines_pull_key_key').on(t.pullId, t.lineKey),
    index('pos_usage_pull_lines_pull_section_idx').on(t.pullId, t.section),
    index('pos_usage_pull_lines_item_idx').on(t.itemId),
    check(
      'pos_usage_pull_lines_quantity_positive_check',
      sql`${t.quantity} is null or ${t.quantity} > 0`,
    ),
    check('pos_usage_pull_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
  ],
);
