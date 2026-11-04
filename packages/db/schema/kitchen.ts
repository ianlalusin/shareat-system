/**
 * T-508 S1 (migration 0232) - kitchen stations and kitchen routes. docs/tasks/508-kitchen-stations-and-menu-to-pos.md R1-R5.
 *
 * `kitchen_stations`: a store's cooking screens (Grill, Drinks...). Store-scoped. A station is RETIRED, never deleted (R3).
 * Its name is the only copy: tickets and the POS read it live, nothing stores a copy of it (R4).
 *
 * `kitchen_routes`: which station cooks which menu ITEM at which store (R2: per item, not per variant, so a kids package is
 * cooked where the adult one is). At most one route per (store, item).
 *
 * The database enforces what must never happen, without a trigger:
 *   - a route's station belongs to the route's own store: composite FK (store_id, station_id, station_status), which also
 *     carries the org (the store belongs to one org);
 *   - a route can only point at an ACTIVE station, and a station that has routes can never be retired (R3): the route carries
 *     `station_status`, pinned to 'active' by a CHECK, inside that same composite FK with ON UPDATE NO ACTION. Flipping the
 *     station to 'retired' while a route still names it breaks the FK (23503). The repo checks first and reports the count.
 *
 * What Drizzle cannot express is hand-added in migration 0232 (NOTE comments below): the case-insensitive partial unique
 * index on the active station name, the parent UNIQUEs on kitchen_stations, RLS and the grants.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { menuItems } from './menu';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const KITCHEN_STATION_STATUSES = ['active', 'retired'] as const;
export type KitchenStationStatus = (typeof KITCHEN_STATION_STATUSES)[number];

/** v1 range for a station's ticket SLA, in minutes (kitchen-locations-settings.tsx): default 10, 1-240. */
export const KITCHEN_SLA_MIN = 1;
export const KITCHEN_SLA_MAX = 240;
export const KITCHEN_SLA_DEFAULT = 10;

// NOTE: kitchen_stations_store_id_id_status_unique is the unique target of the same-store, still-active composite FK on kitchen_routes.
// Hand-added in migration 0232: UNIQUE (store_id, lower(name)) WHERE status = 'active' - kitchen_stations_store_active_name_key.

export const kitchenStations = pgTable(
  'kitchen_stations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    slaMinutes: integer('sla_minutes').notNull().default(KITCHEN_SLA_DEFAULT),
    printOnOutage: boolean('print_on_outage').notNull().default(false),
    status: text('status', { enum: KITCHEN_STATION_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('kitchen_stations_store_id_id_status_unique').on(t.storeId, t.id, t.status),
    // NOTE: UNIQUE (store_id, lower(name)) WHERE status = 'active' - kitchen_stations_store_active_name_key, hand-added in migration 0232.
    index('kitchen_stations_org_store_idx').on(t.orgId, t.storeId),
    check('kitchen_stations_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('kitchen_stations_status_check', sql`${t.status} in ('active','retired')`),
    check('kitchen_stations_sla_minutes_check', sql`${t.slaMinutes} between 1 and 240`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'kitchen_stations_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'kitchen_stations_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const kitchenRoutes = pgTable(
  'kitchen_routes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'restrict' }),
    // No single-column FK and no (org_id, station_id) twin on station_id: the three-column FK below subsumes both (it pins the
    // station to this store, the store to this org, and the station to 'active'). A twin would also make the generic same-org
    // census (t398-s3) re-point station_id at a station of another store and fail.
    stationId: uuid('station_id').notNull(),
    /** Always 'active' (CHECK). It exists only so the composite FK can see the station's status; see the file header. */
    stationStatus: text('station_status').notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('kitchen_routes_store_item_unique').on(t.storeId, t.menuItemId),
    index('kitchen_routes_station_idx').on(t.stationId),
    check('kitchen_routes_station_status_check', sql`${t.stationStatus} = 'active'`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'kitchen_routes_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.menuItemId],
      foreignColumns: [menuItems.orgId, menuItems.id],
      name: 'kitchen_routes_menu_item_id_same_org_fk',
    }).onDelete('restrict'),
    // The route's station is at the route's own store AND is still active (R1, R3). ON UPDATE NO ACTION: retiring the
    // station while this row exists is refused.
    foreignKey({
      columns: [t.storeId, t.stationId, t.stationStatus],
      foreignColumns: [kitchenStations.storeId, kitchenStations.id, kitchenStations.status],
      name: 'kitchen_routes_station_same_store_active_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'kitchen_routes_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
