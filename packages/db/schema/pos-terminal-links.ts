/**
 * T-424 S5 (migration 0202) - which POS v2 tablet is which ERP terminal person, at which store.
 * docs/tasks/424-pos-v2-server-approvals.md Ruling 5 (B1 fix).
 *
 * The POS v2 server maps (POS store id, the tablet's device id) to the terminal person whose own PIN bucket a manager approval charges.
 * That map lives HERE, in Postgres, and is written ONLY by the provisioning writer `provisionPosTerminalLink` (admin capability,
 * audited) - never by a tablet or a request. Nothing in Firestore (a terminals/{TT} claim doc) is ever consulted for the store or the bucket.
 *
 * One ACTIVE link per ERP store (ADR-015 A3: one tablet per store) and one ACTIVE link per device id. A reinstall makes a new device id:
 * the writer revokes the store's old link in the same transaction (revoked_at / revoked_by), it never deletes one.
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { posV1StoreLinks } from './pos-v1';
import { stores } from './stores';

export const posTerminalLinks = pgTable(
  'pos_terminal_links',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The ERP store. */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** The store's `pos_v1_store_links` row (live when written): the Firestore store id is read through it. */
    posV1StoreLinkId: uuid('pos_v1_store_link_id')
      .notNull()
      .references(() => posV1StoreLinks.id, { onDelete: 'restrict' }),
    /** Display only: the terminal number the tablet sells under. */
    terminalNo: integer('terminal_no').notNull(),
    /** The tablet's install id (POS v2 `/settings` shows it). */
    deviceId: uuid('device_id').notNull(),
    /** A `persons` row of kind 'terminal' credentialed to the store: the owner of the PIN bucket an approval charges. */
    terminalPersonId: uuid('terminal_person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    /** Both NULL while the link is active; set together by the writer when a newer link replaces it. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // At most one ACTIVE link per ERP store and per device id (hand-added partial unique indexes in 0202).
    uniqueIndex('pos_terminal_links_active_store_unique').on(t.storeId).where(sql`${t.revokedAt} is null`),
    uniqueIndex('pos_terminal_links_active_device_unique').on(t.deviceId).where(sql`${t.revokedAt} is null`),
    index('pos_terminal_links_org_store_idx').on(t.orgId, t.storeId),
    check('pos_terminal_links_terminal_no_check', sql`${t.terminalNo} > 0`),
    check('pos_terminal_links_revoked_shape_check', sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`),
    // T-398 same-org twins (composite FKs through persons_org_id_id_unique / stores_org_id_id_unique / pos_v1_store_links_org_id_id_unique).
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_terminal_links_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.terminalPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pos_terminal_links_terminal_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_terminal_links_created_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.revokedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_terminal_links_revoked_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.posV1StoreLinkId],
      foreignColumns: [posV1StoreLinks.orgId, posV1StoreLinks.id],
      name: 'pos_terminal_links_pos_v1_store_link_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export type PosTerminalLink = typeof posTerminalLinks.$inferSelect;
