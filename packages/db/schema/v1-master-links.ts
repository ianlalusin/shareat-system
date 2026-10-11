/**
 * v1_master_links - T-391 S1 (migration 0193). docs/tasks/391-production-master-data-load.md.
 *
 * One row per v1 record the master-data load created or matched: (org, entity, v1 store, v1 id) -> v2 id. It is the
 * key a re-run reads (nothing already linked is written again) and the key T-390's price list reads to turn a v1 item
 * id into a v2 item and a factor. `v1StoreId` is '' for an org-level v1 document. `v2Id` is polymorphic by `entity`,
 * so it carries no FK; a test resolves it. An item link carries the v1 unit and `factorToBase`; every other entity
 * carries neither. A link is a fact about the load: the app role has no UPDATE and no DELETE.
 */
import { sql } from 'drizzle-orm';
import { check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';

export const V1_LINK_ENTITIES = ['item', 'supplier', 'customer', 'person', 'employment', 'position'] as const;
export type V1LinkEntity = (typeof V1_LINK_ENTITIES)[number];

export const v1MasterLinks = pgTable(
  'v1_master_links',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entity: text('entity', { enum: V1_LINK_ENTITIES }).notNull(),
    v1StoreId: text('v1_store_id').notNull(),
    v1Id: text('v1_id').notNull(),
    v2Id: uuid('v2_id').notNull(),
    v1Unit: text('v1_unit'),
    factorToBase: numeric('factor_to_base', { precision: 14, scale: 6 }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('v1_master_links_key').on(t.orgId, t.entity, t.v1StoreId, t.v1Id),
    index('v1_master_links_v2_idx').on(t.orgId, t.entity, t.v2Id),
    check('v1_master_links_entity_check', sql`${t.entity} in ('item','supplier','customer','person','employment','position')`),
    check('v1_master_links_v1_id_not_blank_check', sql`btrim(${t.v1Id}) <> ''`),
    check('v1_master_links_factor_to_base_finite_check', sql`${t.factorToBase} > '-Infinity'::numeric and ${t.factorToBase} < 'Infinity'::numeric`),
    check(
      'v1_master_links_item_factor_check',
      sql`(${t.entity} = 'item' AND ${t.factorToBase} IS NOT NULL AND ${t.factorToBase} > 0 AND ${t.factorToBase} < 'Infinity'::numeric AND ${t.v1Unit} IS NOT NULL) OR (${t.entity} <> 'item' AND ${t.factorToBase} IS NULL AND ${t.v1Unit} IS NULL)`,
    ),
  ],
);
// NOTE: ENABLE + FORCE ROW LEVEL SECURITY, the org-isolation policy and the SELECT, INSERT-only grant are hand-added in
// migration 0193.
