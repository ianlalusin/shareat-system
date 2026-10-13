/**
 * Stock locations — the room model every inventory movement is keyed to. T-160.
 *
 * ## ⭐ Why this table exists before the stock ledger, and not after
 *
 * Retrofitting a location dimension onto a populated stock ledger is the same class of expense as
 * retrofitting RLS: cheap per table now, a week and a silent miss later. v1 lived the alternative —
 * `branch-stock-reconcile.actions.ts` exists ONLY to collapse branches that drifted into multiple
 * rooms during a legacy dual-write, floor negative balances to zero, and delete the strays.
 *
 * ⭐ **v2 needs no such tool, because the invariant it enforces is structural here** — see
 * `singleRoomViolation` in `packages/domain/src/stock-locations/rules.ts`.
 *
 * ## The two decisions v1 got right and this preserves
 *
 * ⭐ **1. `role` encodes WHERE usage may post from.** A storage room (stockroom) cannot be a usage
 * source; only an `operating` room (kitchen, display) can. v1 enforced this at every usage and
 * wastage post, and it is the difference between "stock left the building" and "stock moved".
 *
 * ⭐ **2. An unknown role migrates to `storage`, which is the FAIL-SAFE direction** — v1's own
 * words: *"a mis-migrated location can't silently drain stock."* Stated here rather than
 * re-derived, because the safe direction is not obvious until you have picked the wrong one.
 *
 * ## ⚠️ Not yet enforced by the database — the migration is deferred
 *
 * Five of T-160's invariants are partial unique indexes and triggers (one Receiving location per
 * store, one default room per store, no deactivation while holding stock, the single-room rule).
 * **They live in the migration, and the migration is written but NOT journalled** — a peer session
 * held `migrations/meta/_journal.json` uncommitted for T-153 when this landed, and editing it would
 * have swept their work into this commit. See `0062_t160_stock_locations.sql`'s header.
 *
 * ⛔ **`stores.stock_model` is deliberately NOT declared here yet.** Adding a column to an EXISTING
 * table before its migration runs would make every `select` against `stores` name a column the
 * database does not have — which breaks the other sessions sharing this checkout, not just this
 * branch. New tables are additive and safe; a new column on a live table is not.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * ⭐ Where usage may post FROM. Not a label — a control.
 *
 * `storage` — a stockroom. Holds stock, and stock may be transferred in and out of it, but nothing
 * may be *consumed* from it: consumption there would mean the count was never taken.
 * `operating` — a kitchen, a bar, a display case. The places stock is actually used up.
 */
export const LOCATION_ROLES = ['storage', 'operating'] as const;
export type LocationRole = (typeof LOCATION_ROLES)[number];

/**
 * ⭐ `receiving` is the parking spot, and it is a PURPOSE rather than a type, because the type
 * catalogue is per-org and editable while this one location's behaviour is structural.
 *
 * Received-but-not-yet-allocated stock lands here rather than being guessed into the default room.
 * v1's rule, kept exactly: *"so stock is never lost."*
 */
export const LOCATION_PURPOSES = ['normal', 'receiving'] as const;
export type LocationPurpose = (typeof LOCATION_PURPOSES)[number];

export const LOCATION_STATUSES = ['active', 'inactive'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/**
 * What KINDS of physical space a store can have — Stockroom, Display, Kitchen, Receiving,
 * Quarantine, In-Transit, Returns. Per org so a commissary and a kiosk can describe themselves
 * differently without either inventing a private vocabulary.
 */
export const locationTypes = pgTable(
  'location_types',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('location_types_org_code_key').on(t.orgId, t.code),
    check('location_types_code_not_blank_check', sql`length(trim(${t.code})) > 0`),
    check('location_types_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
  ],
);

export const stockLocations = pgTable(
  'stock_locations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** Short human key, unique within the store — `STOCKROOM`, `KITCHEN`. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => locationTypes.id, { onDelete: 'restrict' }),
    /** ⭐ See `LOCATION_ROLES`. Defaults to the fail-safe direction. */
    role: text('role', { enum: LOCATION_ROLES }).notNull().default('storage'),
    purpose: text('purpose', { enum: LOCATION_PURPOSES }).notNull().default('normal'),
    /** The receive picker's pre-fill target. Exactly one per store — a partial unique index in
     *  the migration, never a service-layer check. */
    isDefault: boolean('is_default').notNull().default(false),
    /** ⛔ A location with movements behind it is DEACTIVATED, never deleted (invariant 7). */
    status: text('status', { enum: LOCATION_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('stock_locations_store_code_key').on(t.storeId, t.code),
    index('stock_locations_store_status_idx').on(t.storeId, t.status),
    index('stock_locations_org_idx').on(t.orgId),
    check('stock_locations_code_not_blank_check', sql`length(trim(${t.code})) > 0`),
    check('stock_locations_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    /** ⭐ The Receiving room is a parking spot, never a place stock is consumed from. */
    check(
      'stock_locations_receiving_is_storage_check',
      sql`${t.purpose} <> 'receiving' or ${t.role} = 'storage'`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'stock_locations_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'stock_locations_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * Attribution for usage — kitchen, bar, and so on — so consumption can be reported by department
 * without each module inventing its own spelling. Org-level: a department means the same thing in
 * every store, which is the whole point of reporting on it.
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: LOCATION_STATUSES }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('departments_org_code_key').on(t.orgId, t.code),
    check('departments_code_not_blank_check', sql`length(trim(${t.code})) > 0`),
    check('departments_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
  ],
);
