/**
 * store_channel_settlement_configs — per-store identity and matching rules for platform payouts.
 *
 * T-564 (T-515 re-applied on main). v1 kept this under `Store.channelSettlement`. ⚠️ **STORED, NOT YET READ BY INTAKE:** nothing
 * resolves a store from these columns today; the settlement preview only warns when they are missing. Do not invent a reader here.
 *
 * - `store_key` — the stable slug used in cross-store loan wording and idempotency. Immutable once saved in the domain; the
 *   unique index is per organisation.
 * - `match_labels` — outlet-name fragments matched against a PDF/CSV before parsing.
 * - `file_hints` — filename prefixes used to route a bulk upload to the right store.
 * - `wastage_email_ingest_enabled` — fail-closed opt-in, default false.
 *
 * ⛔ The platform and its statement store code are NOT here: they are `sales_channels.platform` and
 * `sales_channels.platform_store_code` (T-511 S2a, migration 0228). T-515's copies of both were dropped on purpose.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';

export const storeChannelSettlementConfigs = pgTable(
  'store_channel_settlement_configs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** Lowercase slug. The domain refuses a change once saved; the database holds uniqueness. */
    storeKey: text('store_key').notNull(),
    matchLabels: text('match_labels').array().notNull().default(sql`'{}'::text[]`),
    fileHints: text('file_hints').array().notNull().default(sql`'{}'::text[]`),
    wastageEmailIngestEnabled: boolean('wastage_email_ingest_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('store_channel_settlement_configs_org_store_unique').on(t.orgId, t.storeId),
    uniqueIndex('store_channel_settlement_configs_org_key_unique').on(t.orgId, t.storeKey),
    index('store_channel_settlement_configs_org_idx').on(t.orgId),
    check(
      'store_channel_settlement_store_key_check',
      sql`${t.storeKey} ~ '^[a-z0-9][a-z0-9-]{1,23}$'`,
    ),
    // NOTE: ENABLE + FORCE ROW LEVEL SECURITY, the org-isolation policy and the SELECT/INSERT/UPDATE grants are hand-added in
    // migration 0257; Drizzle cannot express them.
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'store_channel_settlement_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
