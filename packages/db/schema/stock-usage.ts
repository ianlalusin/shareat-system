/**
 * Usage, wastage and adjustment — T-168. The busiest door in the domain.
 *
 * ⭐ **v1 has TWO of these and v2 has one.** `general-inventory.actions.ts` handles items and
 * `meat-usage.actions.ts` handles meat, each with its own draft/post/void lifecycle, its own race
 * guard, and its own copy of the same rules. That split exists only because `meatProducts` and
 * `inventoryProducts` were separate collections — **a duality v1 was already retiring itself**
 * (`types/item.ts:3`: *"Single source of truth for all item types… Replaces the split"*).
 *
 * T-145 finished that migration: one `items` table, `kind` including `meat_slab` and
 * `meat_sliced`. ⭐ **So the meat-specific rules become rules about a `kind`, not a second
 * module** — and the 8 transaction sites in v1's busiest file become one.
 *
 * ## Draft → post → void, and only the middle one moves anything
 *
 * A floor worker records what was used; a manager posts it. **Posting is the only step that
 * touches stock**, which is what makes the record reviewable before it is real.
 *
 * ## ⚠️ The footgun this table is shaped around
 *
 * A usage record labelled `transfer` is **REJECTED**. v1's reason is exact: the usage flow writes
 * only an OUT leg, so a movement mislabelled as a transfer **destroys stock instead of moving
 * it** — it leaves one location and arrives nowhere. Enforced in the domain (shared list) and,
 * for the reason code, in the database.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { departments, stockLocations } from './stock-locations';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockMovements } from './stock-ledger';
import { stores } from './stores';

/**
 * ⚠️ `opening` is narrowed from v1 deliberately — see T-168 §7.2. v1 lets a manager set, edit and
 * RESET an opening balance at any time; an opening balance that can be re-typed after postings
 * exist is a plug, and `balanceadjustment.plug` is in `POSTING-PATTERNS.md` precisely so nobody
 * ports one forward. What survives is a NEW STORE's opening balance, admin-only.
 */
export const USAGE_KINDS = ['usage', 'wastage', 'adjustment', 'opening'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_STATUSES = ['draft', 'posted', 'void'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export const stockUsageRecords = pgTable(
  'stock_usage_records',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** ⭐ Required where the store has operating rooms — see the migration's trigger. */
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: USAGE_KINDS }).notNull(),
    status: text('status', { enum: USAGE_STATUSES }).notNull().default('draft'),
    usedOn: date('used_on').notNull(),
    /** Attribution for cost reporting — kitchen, bar. Usage only. */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'restrict' }),
    /** From `WASTAGE_REASONS`. Required for `wastage`, forbidden elsewhere. */
    reasonCode: text('reason_code'),
    /** Free text. Required for `adjustment` — a correction nobody explained is a plug. */
    adjustmentReason: text('adjustment_reason'),
    /** ⚠️ Wastage only. Phase 5 owns the advance this draws; the post refuses if it is absent. */
    chargePersonId: uuid('charge_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    /**
     * T-401 S6 (migration 0198). True when the system posted this record itself (`autoPostDueUsageDrafts`, 14:00 Manila the day
     * after its business date) instead of a manager. Out-of-band lines of such a record were posted at the EXPECTED quantity.
     */
    autoPosted: boolean('auto_posted').notNull().default(false),
    /**
     * T-401 S6 audit ruling A7 (migration 0198). True when the POS pull that made this draft was voided after staff had edited it: the
     * draft is kept as a MANUAL draft (nothing links it to a pull, so it never auto-posts) and the queue flags it "pull voided - check".
     */
    pullVoided: boolean('pull_voided').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_usage_auto_posted_shape_check', sql`${t.autoPosted} = false or ${t.postedAt} is not null`),
    check('stock_usage_wastage_reason_check', sql`${t.kind} <> 'wastage' or ${t.reasonCode} is not null`),
    check('stock_usage_reason_only_on_wastage_check', sql`${t.kind} = 'wastage' or ${t.reasonCode} is null`),
    check(
      'stock_usage_adjustment_reason_check',
      sql`${t.kind} <> 'adjustment' or ${t.adjustmentReason} is not null`,
    ),
    /** ⚠️ Only a wastage can be charged to somebody. Charging a routine usage to a cook is not a
     *  control, it is a grievance. */
    check('stock_usage_charge_only_on_wastage_check', sql`${t.chargePersonId} is null or ${t.kind} = 'wastage'`),
    check(
      'stock_usage_posted_shape_check',
      sql`${t.status} <> 'posted' or (${t.postedAt} is not null and ${t.postedBy} is not null)`,
    ),
    check(
      'stock_usage_void_shape_check',
      sql`${t.status} <> 'void' or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)`,
    ),
    index('stock_usage_store_status_idx').on(t.storeId, t.status, t.usedOn),
    index('stock_usage_org_idx').on(t.orgId),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.chargePersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_usage_records_charge_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_usage_records_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.postedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_usage_records_posted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'stock_usage_records_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_usage_records_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `department_id` FK (RLS checks only this row's org_id); references `departments_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
      name: 'stock_usage_records_department_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `location_id` FK (RLS checks only this row's org_id); references `stock_locations_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.locationId],
      foreignColumns: [stockLocations.orgId, stockLocations.id],
      name: 'stock_usage_records_location_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const stockUsageLines = pgTable(
  'stock_usage_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    recordId: uuid('record_id')
      .notNull()
      .references(() => stockUsageRecords.id, { onDelete: 'cascade' }),
    lineNo: text('line_no').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /**
     * ⭐ SIGNED **only** for `adjustment`. A usage or wastage line is always positive — the
     * direction is the record's kind, not the line's sign, and letting a usage carry a negative
     * quantity would make "used −5" a silent stock-in.
     */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /**
     * T-401 S6 audit ruling A4 (migration 0198). What the POS pull expected for this line when it wrote it - a SNAPSHOT, never recomputed.
     * Null for a line staff added by hand.
     */
    expectedQty: numeric('expected_qty', { precision: 14, scale: 3 }),
    movementId: uuid('movement_id').references(() => stockMovements.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_usage_lines_record_line_key').on(t.recordId, t.lineNo),
    check('stock_usage_lines_expected_qty_check', sql`${t.expectedQty} is null or ${t.expectedQty} >= 0`),
    check('stock_usage_lines_expected_qty_finite_check', sql`${t.expectedQty} > '-Infinity'::numeric and ${t.expectedQty} < 'Infinity'::numeric`),
    check('stock_usage_lines_quantity_not_zero_check', sql`${t.quantity} <> 0`),
    index('stock_usage_lines_item_idx').on(t.itemId),
    check('stock_usage_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
  ],
);
