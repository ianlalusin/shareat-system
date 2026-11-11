/**
 * T-523 (migration 0238) - POS v2 schema: the per-store switch, stands, terminals, table sessions, session lines, sales receipts
 * (+ lines, payments, senior/PWD discounts), the day close (the Z), and the event inbox.
 * docs/tasks/523-pos-v2-schema.md R1-R12; bible rows 430, 431, 435, 436, 437.
 *
 * Postgres owns these records (ADR-015 Amendment 2): the tablet's Firestore is gone, the outbox lands in `pos_events`, and the
 * floor state is a set of ordinary rows. NOTHING reads or writes these tables until a store's `pos_stores.mode` is turned on
 * (row 435), so the migration is inert on its own.
 *
 * Words (docs/GLOSSARY.md): a `table_session` is a seated party or a take-out order, never an auth session. A
 * `pos_sales_receipt` is the sales receipt, never bare "receipt" and never `pos_bridge_receipts` (the read-only v1 copy).
 *
 * R13 (planner ruling, 6 Nov): an itemised bill with a discount per item line, as v1 has (a discount covers N units of one line):
 * `pos_discount_presets` (keep), `table_session_line_discounts` (purge), `pos_sales_receipt_line_discounts` (purge, append-only). A senior's own
 * head is 1 unit of the package line; a dish ordered only for them is units of that dish's line.
 *
 * What the DATABASE keeps (see the migration header): one open session per stand; forward-only session status; a line never lands
 * in a paid or voided session; a sales receipt is frozen at insert (only `day_close_id` may be set, once); `(terminal_id, receipt_seq)`
 * and `(pairing_id, seq)` are unique; a Z, a receipt line and a senior/PWD discount row are append-only. What it does NOT keep (T-524):
 * that `discount_total` equals the sum of the discount rows, that a payment's tender is of the receipt's store, that change is given
 * from cash only, that a tablet total equals the server's.
 *
 * Same-org twins from birth (T-398 / DEF-491): every person, store, menu, tender, statutory and parent-table reference has
 * the single-column FK and its `(org_id, x)` twin. References to a STORE-SCOPED parent (a stand, a session, a terminal, a kitchen
 * station, a paired tablet, a day close) use the `(store_id, x)` composite instead, which carries the store and, through `(org_id, store_id)`, the org.
 *
 * What Drizzle cannot express is hand-added in migration 0238 (NOTE comments below): the partial unique / partial indexes, the
 * ENABLE ALWAYS history_guard triggers and their functions, RLS + policies, the column-level grants, and three parent uniques on
 * EXISTING tables so the twins and composites have a target:
 *   // NOTE: pos_tablet_pairings_store_id_id_unique UNIQUE (store_id, id) - hand-added in migration 0238 (T-523); the target of every (store_id, pairing_id) composite here.
 *   // NOTE: kitchen_stations_store_id_id_unique UNIQUE (store_id, id) - hand-added in migration 0238 (T-523); the target of table_session_lines' station composite.
 *   // NOTE: statutory_discount_records_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0238 (T-523); the twin target of pos_sales_receipt_line_discounts.statutory_record_id.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { kitchenStations } from './kitchen';
import { menuItems, menuItemVariants } from './menu';
import { organizations } from './organizations';
import { persons } from './persons';
import { posTabletPairings } from './pos-tablet-pairings';
import { tenders } from './pos-v1';
import { statutoryDiscountRecords } from './statutory-discounts';
import { stores } from './stores';

export const POS_STORE_MODES = ['off', 'test', 'live'] as const;
export type PosStoreMode = (typeof POS_STORE_MODES)[number];
export const POS_STAND_STATUSES = ['active', 'retired'] as const;
export const TABLE_SESSION_MODES = ['dine_in', 'take_out'] as const;
export const TABLE_SESSION_STATUSES = ['open', 'paid', 'voided'] as const;
export type TableSessionStatus = (typeof TABLE_SESSION_STATUSES)[number];
export const SESSION_LINE_KINDS = ['package', 'item', 'refill'] as const;
export const KITCHEN_LINE_STATUSES = ['queued', 'served', 'cancelled'] as const;
export type KitchenLineStatus = (typeof KITCHEN_LINE_STATUSES)[number];
export const POS_EVENT_STATUSES = ['applied', 'quarantined'] as const;
export type PosEventStatus = (typeof POS_EVENT_STATUSES)[number];
export const POS_EVENT_RESOLUTIONS = ['replayed', 'discarded'] as const;
export const LINE_DISCOUNT_KINDS = ['senior', 'pwd', 'preset', 'custom'] as const;
export const DISCOUNT_VALUE_TYPES = ['percent', 'fixed'] as const;
export const POS_PRESET_STATUSES = ['active', 'retired'] as const;
export const LINE_DISCOUNT_STATUSES = ['active', 'removed'] as const;

/** Same-org twin: `(org_id, col)` -> `parent (org_id, id)`. Defined once so the 40-odd twins below cannot drift in shape. */
const twin = (name: string, orgId: AnyPgColumn, col: AnyPgColumn, parentOrgId: AnyPgColumn, parentId: AnyPgColumn) =>
  foreignKey({ columns: [orgId, col], foreignColumns: [parentOrgId, parentId], name }).onDelete('restrict');

const orgIdCol = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' });
const storeIdCol = () =>
  uuid('store_id')
    .notNull()
    .references(() => stores.id, { onDelete: 'restrict' });
const personCol = (name: string) => uuid(name).references(() => persons.id, { onDelete: 'restrict' });

// ---------------------------------------------------------------------------------------------------------------------
// R1 pos_stores - the per-store switch and the polling counter. keep.
// ---------------------------------------------------------------------------------------------------------------------
export const posStores = pgTable(
  'pos_stores',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** Row 435: every store is `off` until its go-live; `test` is for the soak and emulator stores. Changes are audited by the domain (T-524). */
    mode: text('mode', { enum: POS_STORE_MODES }).notNull().default('off'),
    /** NULL unless live (CHECK). */
    liveFrom: date('live_from'),
    /** Bumped by the domain in the same transaction as any change a screen polls for; the poll route answers 304 while it is unchanged. */
    stateVersion: bigint('state_version', { mode: 'number' }).notNull().default(0),
    changedBy: personCol('changed_by').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pos_stores_store_id_unique').on(t.storeId),
    check('pos_stores_mode_check', sql`${t.mode} in ('off','test','live')`),
    check('pos_stores_live_from_check', sql`(${t.mode} = 'live') = (${t.liveFrom} is not null)`),
    check('pos_stores_state_version_check', sql`${t.stateVersion} >= 0`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_stores_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.changedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_stores_changed_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R2 pos_stands - the store's fixed stand set (row 371). keep.
// ---------------------------------------------------------------------------------------------------------------------
export const posStands = pgTable(
  'pos_stands',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    number: smallint('number').notNull(),
    status: text('status', { enum: POS_STAND_STATUSES }).notNull().default('active'),
    createdBy: personCol('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // Retired numbers are never reused, so no partial index.
    unique('pos_stands_store_number_unique').on(t.storeId, t.number),
    unique('pos_stands_store_id_id_unique').on(t.storeId, t.id),
    check('pos_stands_number_check', sql`${t.number} between 1 and 999`),
    check('pos_stands_status_check', sql`${t.status} in ('active','retired')`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_stands_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_stands_created_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R3 pos_terminals - the stable receipt-number identity. keep.
// ---------------------------------------------------------------------------------------------------------------------
export const posTerminals = pgTable(
  'pos_terminals',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    terminalNo: smallint('terminal_no').notNull(),
    /** The tablet currently acting as this terminal. Receipts key on the TERMINAL, events on the PAIRING: a replaced tablet keeps the receipt series (DEF-587). */
    /** Composite FK (store_id, pairing_id) -> pos_tablet_pairings, hand-added in migration 0238 (no single-column FK). */
    pairingId: uuid('pairing_id'),
    /** T-546 (0246): the receipt roll in this till's printer, 58 or 80 mm. The tablet prints with it (snapshot R3); a replaced tablet inherits it. */
    receiptPaperMm: smallint('receipt_paper_mm').notNull().default(58),
    /** T-546 (0246): customer copies per receipt, 1 to 3. */
    receiptCopies: smallint('receipt_copies').notNull().default(1),
    createdBy: personCol('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('pos_terminals_store_terminal_no_unique').on(t.storeId, t.terminalNo),
    unique('pos_terminals_store_id_id_unique').on(t.storeId, t.id),
    // NOTE: pos_terminals_pairing_key, a partial UNIQUE (pairing_id) WHERE pairing_id IS NOT NULL - hand-added in migration 0238.
    uniqueIndex('pos_terminals_pairing_key').on(t.pairingId).where(sql`${t.pairingId} is not null`),
    check('pos_terminals_terminal_no_check', sql`${t.terminalNo} between 1 and 99`),
    check('pos_terminals_receipt_paper_mm_check', sql`${t.receiptPaperMm} in (58, 80)`),
    check('pos_terminals_receipt_copies_check', sql`${t.receiptCopies} between 1 and 3`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_terminals_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_terminals_created_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.pairingId], foreignColumns: [posTabletPairings.storeId, posTabletPairings.id], name: 'pos_terminals_pairing_same_store_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R4 table_sessions - a seated party or a take-out order. purge.
// ---------------------------------------------------------------------------------------------------------------------
export const tableSessions = pgTable(
  'table_sessions',
  {
    /** May be supplied by the device (uuidv7 made offline); the default still applies when the server creates the row. */
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** NULL for take-out (CHECK: dine_in iff a stand). Composite FK (store_id, stand_id) -> pos_stands, hand-added in migration 0238 (no single-column FK). */
    standId: uuid('stand_id'),
    mode: text('mode', { enum: TABLE_SESSION_MODES }).notNull(),
    /** Heads the cashier entered; 0 only for take-out. The billed head count is greatest(heads_cashier, coalesce(heads_server, 0)), computed by T-524, never stored. */
    headsCashier: integer('heads_cashier').notNull(),
    headsServer: integer('heads_server'),
    status: text('status', { enum: TABLE_SESSION_STATUSES }).notNull().default('open'),
    openedBy: personCol('opened_by').notNull(),
    openedAtDevice: timestamp('opened_at_device', { withTimezone: true }).notNull(),
    /** Composite FK (store_id, opened_on_pairing_id) -> pos_tablet_pairings, hand-added in migration 0238. */
    openedOnPairingId: uuid('opened_on_pairing_id').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    voidedBy: personCol('voided_by'),
    voidedAtDevice: timestamp('voided_at_device', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedOffline: boolean('voided_offline').notNull().default(false),
  },
  (t) => [
    unique('table_sessions_store_id_id_unique').on(t.storeId, t.id),
    // NOTE: table_sessions_one_open_per_stand_key, a partial UNIQUE (stand_id) WHERE status = 'open' AND stand_id IS NOT NULL - hand-added in migration 0238 (row 371).
    uniqueIndex('table_sessions_one_open_per_stand_key')
      .on(t.standId)
      .where(sql`${t.status} = 'open' and ${t.standId} is not null`),
    // NOTE: table_sessions_store_open_idx, a partial index (store_id, opened_at) WHERE status = 'open' - hand-added in migration 0238.
    index('table_sessions_store_open_idx')
      .on(t.storeId, t.openedAt)
      .where(sql`${t.status} = 'open'`),
    // NOTE: the forward-only trigger table_sessions_forward_only (open -> paid | voided, 23514; opened_* frozen always and heads / void columns frozen once not open, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('table_sessions_mode_check', sql`${t.mode} in ('dine_in','take_out')`),
    check('table_sessions_stand_mode_check', sql`(${t.mode} = 'dine_in') = (${t.standId} is not null)`),
    check('table_sessions_heads_cashier_check', sql`${t.headsCashier} between 0 and 200`),
    check('table_sessions_dine_in_heads_check', sql`${t.mode} = 'take_out' or ${t.headsCashier} >= 1`),
    check('table_sessions_heads_server_check', sql`${t.headsServer} between 1 and 200`),
    check('table_sessions_status_check', sql`${t.status} in ('open','paid','voided')`),
    check(
      'table_sessions_void_shape_check',
      sql`(${t.status} = 'voided') = (${t.voidedBy} is not null and ${t.voidReason} is not null and length(trim(${t.voidReason})) > 0)`,
    ),
    check('table_sessions_voided_offline_check', sql`${t.voidedOffline} = false or ${t.status} = 'voided'`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'table_sessions_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.standId], foreignColumns: [posStands.storeId, posStands.id], name: 'table_sessions_stand_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.openedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_sessions_opened_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.voidedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_sessions_voided_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.openedOnPairingId], foreignColumns: [posTabletPairings.storeId, posTabletPairings.id], name: 'table_sessions_opened_on_pairing_same_store_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R5 table_session_lines - what was ordered, with kitchen state and refills. purge.
// ---------------------------------------------------------------------------------------------------------------------
export const tableSessionLines = pgTable(
  'table_session_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** Composite FK (store_id, session_id) -> table_sessions, hand-added in migration 0238 (no single-column FK). */
    sessionId: uuid('session_id').notNull(),
    kind: text('kind', { enum: SESSION_LINE_KINDS }).notNull(),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'restrict' }),
    menuItemVariantId: uuid('menu_item_variant_id').references(() => menuItemVariants.id, { onDelete: 'restrict' }),
    /** The name as sold, for the ticket and the slip. */
    name: text('name').notNull(),
    /** A `package` line's qty is the billed head count at payment: T-524 replaces the line (cancelled + new), never edits it. */
    qty: integer('qty').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    /** The heads a "(up to N)" bundle line covers (N > 1), written from the menu at order time; NULL for every other line. Added in migration 0240 (T-524 audit F1); frozen by the line guard like every non-kitchen column. */
    bundleHeads: smallint('bundle_heads'),
    /** The option value ids chosen on this line, sorted and distinct ({} = none); NULL = written before migration 0249 (T-557), options only in `name`. Set at insert, never updated. */
    optionValueIds: uuid('option_value_ids').array(),
    /** Composite FK (store_id, kitchen_station_id) -> kitchen_stations (store_id, id), hand-added in migration 0238 (no single-column FK). */
    kitchenStationId: uuid('kitchen_station_id'),
    kitchenStatus: text('kitchen_status', { enum: KITCHEN_LINE_STATUSES }).notNull().default('queued'),
    servedAtDevice: timestamp('served_at_device', { withTimezone: true }),
    servedBy: personCol('served_by'),
    note: text('note'),
    addedBy: personCol('added_by').notNull(),
    /** NULL when added from a phone browser. */
    /** Composite FK (store_id, added_on_pairing_id) -> pos_tablet_pairings (nullable), hand-added in migration 0238. */
    addedOnPairingId: uuid('added_on_pairing_id'),
    addedAtDevice: timestamp('added_at_device', { withTimezone: true }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('table_session_lines_unit_price_finite_check', sql`${t.unitPrice} > '-Infinity'::numeric and ${t.unitPrice} < 'Infinity'::numeric`),
    unique('table_session_lines_org_id_id_unique').on(t.orgId, t.id),
    unique('table_session_lines_store_id_id_unique').on(t.storeId, t.id),
    // NOTE: table_session_lines_session_idx (store_id, session_id) - hand-added in migration 0238.
    index('table_session_lines_session_idx').on(t.storeId, t.sessionId),
    // NOTE: the trigger table_session_lines_guard (no INSERT into a paid / voided session, 23001; kitchen_status forward-only, 23514; 'cancelled' refused once the session is closed, 23001; other columns frozen) is hand-added in migration 0238, ENABLE ALWAYS.
    check('table_session_lines_kind_check', sql`${t.kind} in ('package','item','refill')`),
    check('table_session_lines_qty_check', sql`${t.qty} > 0`),
    check('table_session_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check('table_session_lines_unit_price_finite_check', sql`${t.unitPrice} > '-Infinity'::numeric and ${t.unitPrice} < 'Infinity'::numeric`),
    check('table_session_lines_refill_free_check', sql`${t.kind} <> 'refill' or ${t.unitPrice} = 0`),
    check('table_session_lines_kitchen_status_check', sql`${t.kitchenStatus} in ('queued','served','cancelled')`),
    check('table_session_lines_served_shape_check', sql`(${t.kitchenStatus} = 'served') = (${t.servedAtDevice} is not null)`),
    check('table_session_lines_note_check', sql`length(${t.note}) <= 200`),
    // NOTE: table_session_lines_bundle_heads_check is added in migration 0240 (T-524 F1).
    check('table_session_lines_bundle_heads_check', sql`${t.bundleHeads} between 1 and 200`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'table_session_lines_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.sessionId], foreignColumns: [tableSessions.storeId, tableSessions.id], name: 'table_session_lines_session_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.kitchenStationId], foreignColumns: [kitchenStations.storeId, kitchenStations.id], name: 'table_session_lines_kitchen_station_same_store_fk' }).onDelete('restrict'),
    twin('table_session_lines_menu_item_id_same_org_fk', t.orgId, t.menuItemId, menuItems.orgId, menuItems.id),
    twin('table_session_lines_menu_item_variant_id_same_org_fk', t.orgId, t.menuItemVariantId, menuItemVariants.orgId, menuItemVariants.id),
    foreignKey({ columns: [t.orgId, t.servedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_session_lines_served_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.addedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_session_lines_added_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.addedOnPairingId], foreignColumns: [posTabletPairings.storeId, posTabletPairings.id], name: 'table_session_lines_added_on_pairing_same_store_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R13 pos_discount_presets - a store's named discounts (master data). keep.
// ---------------------------------------------------------------------------------------------------------------------
export const posDiscountPresets = pgTable(
  'pos_discount_presets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    name: text('name').notNull(),
    valueType: text('value_type', { enum: DISCOUNT_VALUE_TYPES }).notNull(),
    /** A percent (1-100) or a fixed peso amount per unit. */
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    status: text('status', { enum: POS_PRESET_STATUSES }).notNull().default('active'),
    createdBy: personCol('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('pos_discount_presets_org_id_id_unique').on(t.orgId, t.id),
    unique('pos_discount_presets_store_id_id_unique').on(t.storeId, t.id),
    // NOTE: pos_discount_presets_store_active_name_key, UNIQUE (store_id, lower(name)) WHERE status = 'active' - hand-added in migration 0238.
    uniqueIndex('pos_discount_presets_store_active_name_key')
      .on(t.storeId, sql`lower(${t.name})`)
      .where(sql`${t.status} = 'active'`),
    check('pos_discount_presets_name_check', sql`length(trim(${t.name})) between 1 and 40`),
    check('pos_discount_presets_value_type_check', sql`${t.valueType} in ('percent','fixed')`),
    check('pos_discount_presets_value_check', sql`${t.value} > 0`),
    check('pos_discount_presets_percent_max_check', sql`${t.valueType} <> 'percent' or ${t.value} <= 100`),
    check('pos_discount_presets_status_check', sql`${t.status} in ('active','retired')`),
    check('pos_discount_presets_value_finite_check', sql`${t.value} > '-Infinity'::numeric and ${t.value} < 'Infinity'::numeric`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_discount_presets_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_discount_presets_created_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R13 table_session_line_discounts - a discount on one session line, covering `qty` units of it. purge.
// ---------------------------------------------------------------------------------------------------------------------
export const tableSessionLineDiscounts = pgTable(
  'table_session_line_discounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** Composite FK (store_id, session_line_id) -> table_session_lines, hand-added in migration 0238 (no single-column FK). */
    sessionLineId: uuid('session_line_id').notNull(),
    kind: text('kind', { enum: LINE_DISCOUNT_KINDS }).notNull(),
    /** Composite FK (store_id, preset_id) -> pos_discount_presets, hand-added in migration 0238. Non-null iff kind = 'preset'. */
    presetId: uuid('preset_id'),
    valueType: text('value_type', { enum: DISCOUNT_VALUE_TYPES }).notNull(),
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    /** How many units of the line the discount covers. That it does not exceed the line's qty is a T-524 rule. */
    qty: integer('qty').notNull(),
    /** Senior/PWD only (CHECK): which diner's card this is (row 437: their own package head = 1 unit of the package line). */
    dinerNo: smallint('diner_no'),
    appliedBy: personCol('applied_by').notNull(),
    appliedAtDevice: timestamp('applied_at_device', { withTimezone: true }).notNull(),
    approvedBy: personCol('approved_by'),
    status: text('status', { enum: LINE_DISCOUNT_STATUSES }).notNull().default('active'),
    removedBy: personCol('removed_by'),
    removedAtDevice: timestamp('removed_at_device', { withTimezone: true }),
  },
  (t) => [
    // NOTE: table_session_line_discounts_line_idx (store_id, session_line_id) - hand-added in migration 0238.
    index('table_session_line_discounts_line_idx').on(t.storeId, t.sessionLineId),
    // NOTE: the trigger table_session_line_discounts_guard (INSERT on a paid / voided session's line refused, 23001; active -> removed only, 23514, and refused once the session is closed, 23001; other columns frozen, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('table_session_line_discounts_kind_check', sql`${t.kind} in ('senior','pwd','preset','custom')`),
    check('table_session_line_discounts_preset_kind_check', sql`(${t.kind} = 'preset') = (${t.presetId} is not null)`),
    check('table_session_line_discounts_value_type_check', sql`${t.valueType} in ('percent','fixed')`),
    check('table_session_line_discounts_value_check', sql`${t.value} > 0`),
    check('table_session_line_discounts_percent_max_check', sql`${t.valueType} <> 'percent' or ${t.value} <= 100`),
    check('table_session_line_discounts_qty_check', sql`${t.qty} > 0`),
    check('table_session_line_discounts_diner_no_check', sql`${t.dinerNo} between 1 and 200`),
    check('table_session_line_discounts_statutory_diner_check', sql`(${t.kind} in ('senior','pwd')) = (${t.dinerNo} is not null)`),
    check('table_session_line_discounts_status_check', sql`${t.status} in ('active','removed')`),
    check('table_session_line_discounts_removed_shape_check', sql`(${t.status} = 'removed') = (${t.removedBy} is not null)`),
    check('table_session_line_discounts_value_finite_check', sql`${t.value} > '-Infinity'::numeric and ${t.value} < 'Infinity'::numeric`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'table_session_line_discounts_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.sessionLineId], foreignColumns: [tableSessionLines.storeId, tableSessionLines.id], name: 'table_session_line_discounts_session_line_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.presetId], foreignColumns: [posDiscountPresets.storeId, posDiscountPresets.id], name: 'table_session_line_discounts_preset_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.appliedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_session_line_discounts_applied_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.approvedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_session_line_discounts_approved_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.removedBy], foreignColumns: [persons.orgId, persons.id], name: 'table_session_line_discounts_removed_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R9 pos_day_closes + pos_day_close_tenders - the Z (row 390). Append-only. purge. (Declared before the sales receipt, which points at it.)
// ---------------------------------------------------------------------------------------------------------------------
export const posDayCloses = pgTable(
  'pos_day_closes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** Composite FK (store_id, terminal_id) -> pos_terminals, hand-added in migration 0238. */
    terminalId: uuid('terminal_id').notNull(),
    zNo: integer('z_no').notNull(),
    /** The date the window opened, Manila (rows 348, 390). Never from a device clock. */
    businessDate: date('business_date').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    receiptCount: integer('receipt_count').notNull(),
    grossTotal: numeric('gross_total', { precision: 14, scale: 2 }).notNull(),
    closedBy: personCol('closed_by').notNull(),
    /** A manager (row 390). */
    approvedBy: personCol('approved_by').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pos_day_closes_gross_total_finite_check', sql`${t.grossTotal} > '-Infinity'::numeric and ${t.grossTotal} < 'Infinity'::numeric`),
    unique('pos_day_closes_org_id_id_unique').on(t.orgId, t.id),
    unique('pos_day_closes_store_id_id_unique').on(t.storeId, t.id),
    unique('pos_day_closes_terminal_z_no_unique').on(t.terminalId, t.zNo),
    unique('pos_day_closes_store_date_terminal_unique').on(t.storeId, t.businessDate, t.terminalId),
    // NOTE: the trigger pos_day_closes_append_only (UPDATE / DELETE refused, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('pos_day_closes_z_no_check', sql`${t.zNo} > 0`),
    check('pos_day_closes_window_check', sql`${t.windowEnd} > ${t.windowStart}`),
    check('pos_day_closes_receipt_count_check', sql`${t.receiptCount} >= 0`),
    check('pos_day_closes_gross_total_check', sql`${t.grossTotal} >= 0`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_day_closes_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.terminalId], foreignColumns: [posTerminals.storeId, posTerminals.id], name: 'pos_day_closes_terminal_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.closedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_day_closes_closed_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.approvedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_day_closes_approved_by_same_org_fk' }).onDelete('restrict'),
  ],
);

export const posDayCloseTenders = pgTable(
  'pos_day_close_tenders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    dayCloseId: uuid('day_close_id')
      .notNull()
      .references(() => posDayCloses.id, { onDelete: 'restrict' }),
    tenderId: uuid('tender_id')
      .notNull()
      .references(() => tenders.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    check('pos_day_close_tenders_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    unique('pos_day_close_tenders_day_close_tender_unique').on(t.dayCloseId, t.tenderId),
    // NOTE: the trigger pos_day_close_tenders_append_only (UPDATE / DELETE refused, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    twin('pos_day_close_tenders_day_close_id_same_org_fk', t.orgId, t.dayCloseId, posDayCloses.orgId, posDayCloses.id),
    twin('pos_day_close_tenders_tender_id_same_org_fk', t.orgId, t.tenderId, tenders.orgId, tenders.id),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R6 pos_sales_receipts - the sales receipt. Immutable after insert except day_close_id (NULL -> value once). purge.
// ---------------------------------------------------------------------------------------------------------------------
export const posSalesReceipts = pgTable(
  'pos_sales_receipts',
  {
    /** May be supplied by the device (uuidv7 made offline). */
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** Composite FK (store_id, terminal_id) -> pos_terminals, hand-added in migration 0238. */
    terminalId: uuid('terminal_id').notNull(),
    /** Continuous per terminal, never reset (DEF-001/002/587). The printed number is <store code>-<terminal_no 2 digits>-<receipt_seq 6 digits>, formatted by the app, never stored. */
    terminalSeq: integer('receipt_seq').notNull(),
    /** Composite FK (store_id, table_session_id) -> table_sessions, hand-added in migration 0238. One sales receipt per session. */
    tableSessionId: uuid('table_session_id').notNull(),
    cashierId: personCol('cashier_id').notNull(),
    issuedAtDevice: timestamp('issued_at_device', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
    /** In release 1 only senior/PWD (R12). That it equals the sum of the discount rows is a T-524 rule and test: a CHECK cannot sum child rows. */
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull(),
    /** As the tablet computed it. A mismatch with `total` is not a constraint: T-524 records the server's figure and raises a finding (row 276). */
    deviceTotal: numeric('device_total', { precision: 14, scale: 2 }).notNull(),
    offline: boolean('offline').notNull(),
    /** Composite FK (store_id, day_close_id) -> pos_day_closes, hand-added in migration 0238 (no single-column FK). */
    dayCloseId: uuid('day_close_id'),
  },
  (t) => [
    check('pos_sales_receipts_subtotal_finite_check', sql`${t.subtotal} > '-Infinity'::numeric and ${t.subtotal} < 'Infinity'::numeric`),
    check('pos_sales_receipts_discount_total_finite_check', sql`${t.discountTotal} > '-Infinity'::numeric and ${t.discountTotal} < 'Infinity'::numeric`),
    check('pos_sales_receipts_total_finite_check', sql`${t.total} > '-Infinity'::numeric and ${t.total} < 'Infinity'::numeric`),
    check('pos_sales_receipts_device_total_finite_check', sql`${t.deviceTotal} > '-Infinity'::numeric and ${t.deviceTotal} < 'Infinity'::numeric`),
    unique('pos_sales_receipts_org_id_id_unique').on(t.orgId, t.id),
    unique('pos_sales_receipts_terminal_seq_unique').on(t.terminalId, t.terminalSeq),
    unique('pos_sales_receipts_table_session_unique').on(t.tableSessionId),
    // NOTE: the trigger pos_sales_receipts_session_guard (INSERT for a voided session refused, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    // NOTE: the trigger pos_sales_receipts_frozen (every column frozen, day_close_id set once; DELETE refused; 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('pos_sales_receipts_receipt_seq_check', sql`${t.terminalSeq} > 0`),
    check('pos_sales_receipts_discount_total_check', sql`${t.discountTotal} >= 0`),
    check('pos_sales_receipts_total_check', sql`${t.total} >= 0`),
    check('pos_sales_receipts_total_identity_check', sql`${t.total} = ${t.subtotal} - ${t.discountTotal}`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_sales_receipts_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.terminalId], foreignColumns: [posTerminals.storeId, posTerminals.id], name: 'pos_sales_receipts_terminal_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.tableSessionId], foreignColumns: [tableSessions.storeId, tableSessions.id], name: 'pos_sales_receipts_table_session_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.cashierId], foreignColumns: [persons.orgId, persons.id], name: 'pos_sales_receipts_cashier_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.dayCloseId], foreignColumns: [posDayCloses.storeId, posDayCloses.id], name: 'pos_sales_receipts_day_close_same_store_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R7 pos_sales_receipt_lines - the frozen copy of what was billed. Append-only. purge.
// ---------------------------------------------------------------------------------------------------------------------
export const posSalesReceiptLines = pgTable(
  'pos_sales_receipt_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => posSalesReceipts.id, { onDelete: 'restrict' }),
    lineNo: smallint('line_no').notNull(),
    sessionLineId: uuid('session_line_id').references(() => tableSessionLines.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: SESSION_LINE_KINDS }).notNull(),
    name: text('name').notNull(),
    qty: integer('qty').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    /** Copied from the session line (T-557): sorted, distinct option value ids; NULL = a line written before migration 0249. */
    optionValueIds: uuid('option_value_ids').array(),
    /** qty * unit_price (CHECK). Refills appear at 0. */
    gross: numeric('gross', { precision: 14, scale: 2 }).notNull(),
    /** The sum of this line's discounts (T-524 keeps that equal to pos_sales_receipt_line_discounts; a CHECK cannot sum child rows). */
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 }).notNull().default('0'),
    /** gross - discount_total (CHECK). */
    net: numeric('net', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    check('pos_sales_receipt_lines_unit_price_finite_check', sql`${t.unitPrice} > '-Infinity'::numeric and ${t.unitPrice} < 'Infinity'::numeric`),
    check('pos_sales_receipt_lines_gross_finite_check', sql`${t.gross} > '-Infinity'::numeric and ${t.gross} < 'Infinity'::numeric`),
    check('pos_sales_receipt_lines_discount_total_finite_check', sql`${t.discountTotal} > '-Infinity'::numeric and ${t.discountTotal} < 'Infinity'::numeric`),
    check('pos_sales_receipt_lines_net_finite_check', sql`${t.net} > '-Infinity'::numeric and ${t.net} < 'Infinity'::numeric`),
    unique('pos_sales_receipt_lines_org_id_id_unique').on(t.orgId, t.id),
    unique('pos_sales_receipt_lines_receipt_line_no_unique').on(t.receiptId, t.lineNo),
    // NOTE: the trigger pos_sales_receipt_lines_append_only (UPDATE / DELETE refused, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('pos_sales_receipt_lines_kind_check', sql`${t.kind} in ('package','item','refill')`),
    check('pos_sales_receipt_lines_qty_check', sql`${t.qty} > 0`),
    check('pos_sales_receipt_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check('pos_sales_receipt_lines_gross_check', sql`${t.gross} = ${t.qty} * ${t.unitPrice}`),
    check('pos_sales_receipt_lines_discount_total_check', sql`${t.discountTotal} >= 0`),
    check('pos_sales_receipt_lines_discount_within_gross_check', sql`${t.discountTotal} <= ${t.gross}`),
    check('pos_sales_receipt_lines_net_check', sql`${t.net} = ${t.gross} - ${t.discountTotal}`),
    twin('pos_sales_receipt_lines_receipt_id_same_org_fk', t.orgId, t.receiptId, posSalesReceipts.orgId, posSalesReceipts.id),
    twin('pos_sales_receipt_lines_session_line_id_same_org_fk', t.orgId, t.sessionLineId, tableSessionLines.orgId, tableSessionLines.id),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R8 pos_sales_receipt_payments. Frozen except checked_by / checked_at (NULL -> value once). purge.
// ---------------------------------------------------------------------------------------------------------------------
export const posSalesReceiptPayments = pgTable(
  'pos_sales_receipt_payments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => posSalesReceipts.id, { onDelete: 'restrict' }),
    /** The tender's store equals the sales receipt's store: checked by T-524 (`tenders` has no (store_id, id) unique). */
    tenderId: uuid('tender_id')
      .notNull()
      .references(() => tenders.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** Given from cash only: enforced by T-524 against tenders.kind. */
    changeGiven: numeric('change_given', { precision: 14, scale: 2 }).notNull().default('0'),
    referenceNo: text('reference_no'),
    /** An e-wallet taken offline, to be matched against the statement (A3): needs its reference. */
    toCheck: boolean('to_check').notNull().default(false),
    checkedBy: personCol('checked_by'),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => [
    check('pos_sales_receipt_payments_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    check('pos_sales_receipt_payments_change_given_finite_check', sql`${t.changeGiven} > '-Infinity'::numeric and ${t.changeGiven} < 'Infinity'::numeric`),
    // NOTE: pos_sales_receipt_payments_receipt_idx (receipt_id) - hand-added in migration 0238.
    index('pos_sales_receipt_payments_receipt_idx').on(t.receiptId),
    // NOTE: the trigger pos_sales_receipt_payments_frozen (frozen except checked_by / checked_at, once; DELETE refused; 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('pos_sales_receipt_payments_amount_check', sql`${t.amount} > 0`),
    check('pos_sales_receipt_payments_change_given_check', sql`${t.changeGiven} >= 0`),
    check('pos_sales_receipt_payments_reference_no_check', sql`length(${t.referenceNo}) between 4 and 40`),
    check('pos_sales_receipt_payments_to_check_reference_check', sql`not ${t.toCheck} or ${t.referenceNo} is not null`),
    check('pos_sales_receipt_payments_checked_pair_check', sql`(${t.checkedAt} is null) = (${t.checkedBy} is null)`),
    check('pos_sales_receipt_payments_checked_needs_to_check_check', sql`${t.checkedAt} is null or ${t.toCheck}`),
    twin('pos_sales_receipt_payments_receipt_id_same_org_fk', t.orgId, t.receiptId, posSalesReceipts.orgId, posSalesReceipts.id),
    twin('pos_sales_receipt_payments_tender_id_same_org_fk', t.orgId, t.tenderId, tenders.orgId, tenders.id),
    foreignKey({ columns: [t.orgId, t.checkedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_sales_receipt_payments_checked_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R10 pos_events - the outbox inbox (bible 5.1 Lane B, row 430). Frozen except the three resolution columns. purge (row 436).
// ---------------------------------------------------------------------------------------------------------------------
export const posEvents = pgTable(
  'pos_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    storeId: storeIdCol(),
    /** Composite FK (store_id, pairing_id) -> pos_tablet_pairings, hand-added in migration 0238 (no single-column FK). */
    pairingId: uuid('pairing_id').notNull(),
    /** UNIQUE (pairing_id, seq): a replay is a silent no-op (5.4 rule 4); the domain reads the 23505 as "already applied". */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** e.g. stand.opened, lines.added, sale.completed. The closed list lives in T-525's code, so a new kind needs no migration. */
    kind: text('kind').notNull(),
    /** Raw facts only (5.1): no computed business outcome is trusted from a payload; T-524 recomputes. May carry a senior/PWD holder's name and ID: never logged. */
    payload: jsonb('payload').notNull(),
    personId: personCol('person_id'),
    occurredAtDevice: timestamp('occurred_at_device', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status', { enum: POS_EVENT_STATUSES }).notNull(),
    error: text('error'),
    resolvedBy: personCol('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution', { enum: POS_EVENT_RESOLUTIONS }),
  },
  (t) => [
    unique('pos_events_pairing_seq_unique').on(t.pairingId, t.seq),
    // NOTE: pos_events_quarantined_idx, a partial index (store_id, status) WHERE status = 'quarantined' (the manager's list) - hand-added in migration 0238.
    index('pos_events_quarantined_idx')
      .on(t.storeId, t.status)
      .where(sql`${t.status} = 'quarantined'`),
    // NOTE: the trigger pos_events_frozen (frozen except the resolution columns, once; DELETE refused; 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('pos_events_seq_check', sql`${t.seq} > 0`),
    check('pos_events_kind_check', sql`${t.kind} ~ '^[a-z]+(\\.[a-z_]+)+$'`),
    check('pos_events_payload_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
    check('pos_events_status_check', sql`${t.status} in ('applied','quarantined')`),
    check('pos_events_error_check', sql`(${t.status} = 'quarantined') = (${t.error} is not null)`),
    check('pos_events_resolution_check', sql`${t.resolution} in ('replayed','discarded')`),
    check(
      'pos_events_resolved_shape_check',
      sql`(${t.resolvedAt} is null) = (${t.resolvedBy} is null) and (${t.resolvedAt} is null) = (${t.resolution} is null)`,
    ),
    check('pos_events_resolved_needs_quarantine_check', sql`${t.resolvedAt} is null or ${t.status} = 'quarantined'`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_events_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.storeId, t.pairingId], foreignColumns: [posTabletPairings.storeId, posTabletPairings.id], name: 'pos_events_pairing_same_store_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.personId], foreignColumns: [persons.orgId, persons.id], name: 'pos_events_person_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.resolvedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_events_resolved_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// R13 pos_sales_receipt_line_discounts - a discount on one frozen receipt line (replaces the first draft's per-diner R12 table). Append-only. purge.
// ⛔ The holder's name and ID number are NOT stored here (row 353): they live only in statutory_discount_records (T-137).
// No UNIQUE on statutory_record_id: one statutory row per diner per receipt is pointed to by several line discounts.
// ---------------------------------------------------------------------------------------------------------------------
export const posSalesReceiptLineDiscounts = pgTable(
  'pos_sales_receipt_line_discounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: orgIdCol(),
    receiptLineId: uuid('receipt_line_id')
      .notNull()
      .references(() => posSalesReceiptLines.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: LINE_DISCOUNT_KINDS }).notNull(),
    presetId: uuid('preset_id').references(() => posDiscountPresets.id, { onDelete: 'restrict' }),
    /** The name as printed on the bill. */
    label: text('label').notNull(),
    valueType: text('value_type', { enum: DISCOUNT_VALUE_TYPES }).notNull(),
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    qty: integer('qty').notNull(),
    dinerNo: smallint('diner_no'),
    /** Senior/PWD only (CHECK). */
    vatRemoved: numeric('vat_removed', { precision: 14, scale: 2 }).notNull().default('0'),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull(),
    /** Non-null iff kind is senior/pwd (CHECK). */
    statutoryRecordId: uuid('statutory_record_id').references(() => statutoryDiscountRecords.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // NOTE: pos_sales_receipt_line_discounts_line_idx (receipt_line_id) - hand-added in migration 0238.
    index('pos_sales_receipt_line_discounts_line_idx').on(t.receiptLineId),
    // NOTE: the trigger pos_sales_receipt_line_discounts_append_only (UPDATE / DELETE refused, 23001) is hand-added in migration 0238, ENABLE ALWAYS.
    check('pos_sales_receipt_line_discounts_kind_check', sql`${t.kind} in ('senior','pwd','preset','custom')`),
    check('pos_sales_receipt_line_discounts_preset_kind_check', sql`(${t.kind} = 'preset') = (${t.presetId} is not null)`),
    check('pos_sales_receipt_line_discounts_value_type_check', sql`${t.valueType} in ('percent','fixed')`),
    check('pos_sales_receipt_line_discounts_value_check', sql`${t.value} > 0`),
    check('pos_sales_receipt_line_discounts_percent_max_check', sql`${t.valueType} <> 'percent' or ${t.value} <= 100`),
    check('pos_sales_receipt_line_discounts_qty_check', sql`${t.qty} > 0`),
    check('pos_sales_receipt_line_discounts_diner_no_check', sql`${t.dinerNo} between 1 and 200`),
    check('pos_sales_receipt_line_discounts_vat_removed_check', sql`${t.vatRemoved} >= 0`),
    check('pos_sales_receipt_line_discounts_vat_statutory_only_check', sql`${t.kind} in ('senior','pwd') or ${t.vatRemoved} = 0`),
    check('pos_sales_receipt_line_discounts_discount_amount_check', sql`${t.discountAmount} > 0`),
    check('pos_sales_receipt_line_discounts_statutory_record_check', sql`(${t.kind} in ('senior','pwd')) = (${t.statutoryRecordId} is not null)`),
    check('pos_sales_receipt_line_discounts_value_finite_check', sql`${t.value} > '-Infinity'::numeric and ${t.value} < 'Infinity'::numeric`),
    check('pos_sales_receipt_line_discounts_vat_removed_finite_check', sql`${t.vatRemoved} > '-Infinity'::numeric and ${t.vatRemoved} < 'Infinity'::numeric`),
    check('pos_sales_receipt_line_discounts_discount_amount_finite_check', sql`${t.discountAmount} > '-Infinity'::numeric and ${t.discountAmount} < 'Infinity'::numeric`),
    twin('pos_sales_receipt_line_discounts_receipt_line_id_same_org_fk', t.orgId, t.receiptLineId, posSalesReceiptLines.orgId, posSalesReceiptLines.id),
    twin('pos_sales_receipt_line_discounts_preset_id_same_org_fk', t.orgId, t.presetId, posDiscountPresets.orgId, posDiscountPresets.id),
    twin('pos_sales_receipt_line_discounts_statutory_same_org_fk', t.orgId, t.statutoryRecordId, statutoryDiscountRecords.orgId, statutoryDiscountRecords.id),
  ],
);

export type PosStoreRow = typeof posStores.$inferSelect;
export type PosStandRow = typeof posStands.$inferSelect;
export type PosTerminalRow = typeof posTerminals.$inferSelect;
export type TableSessionRow = typeof tableSessions.$inferSelect;
export type PosDiscountPresetRow = typeof posDiscountPresets.$inferSelect;
export type TableSessionLineDiscountRow = typeof tableSessionLineDiscounts.$inferSelect;
export type TableSessionLineRow = typeof tableSessionLines.$inferSelect;
export type PosSalesReceiptRow = typeof posSalesReceipts.$inferSelect;
export type PosEventRow = typeof posEvents.$inferSelect;
