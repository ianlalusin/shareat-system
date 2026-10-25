/**
 * T-375 S1 (DEF-586), migration 0183 - the POS v1 day feed, `docs/tasks/375-pos-v1-day-feed.md` R1.
 *
 * A sales day for a store LINKED to POS is a closing DERIVED from what POS v1 reported (bible row 270). These
 * four tables are the structure behind that; enforcement (the link-aware triggers) is 0184.
 *
 *  - `pos_v1_store_links`        one row per linked store. ITS LIVE ROW IS THE PER-STORE SWITCH (I10; T-382: live means
 *                                not unlinked): no flag column, no env var. Never deleted (no DELETE grant).
 *  - `pos_v1_day_feeds`          the stored, immutable copy of one POS HTTP response. Append-only: no dedupe, each
 *                                fetch is a fact.
 *  - `tenders`                   the store-scoped tender master (S2). NOT `sales_day_tenders`, which is a day's
 *                                wallet rows. See docs/GLOSSARY.md "tender (master)".
 *  - `sales_day_pos_corrections` a manager's correcting entry after POS changed a verified day (S6). Append-only.
 *
 * Interim by design: the feed retires per store at P2, when that store's receipts reach Postgres (ADR-015 section 2).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { salesChannels, salesDays } from './sales-days';
import { stores } from './stores';

export const POS_V1_TAX_TYPES = ['vat_inclusive', 'vat_exclusive', 'non_vat'] as const;
export type PosV1TaxType = (typeof POS_V1_TAX_TYPES)[number];

export const POS_V1_FEED_KINDS = ['sales', 'sold_items'] as const;
export type PosV1FeedKind = (typeof POS_V1_FEED_KINDS)[number];

export const POS_V1_FEED_PURPOSES = ['import', 'recheck', 'usage'] as const;
export type PosV1FeedPurpose = (typeof POS_V1_FEED_PURPOSES)[number];

export const TENDER_KINDS = ['cash', 'wallet'] as const;
export type TenderKind = (typeof TENDER_KINDS)[number];

export const SALES_DAY_SOURCES = ['legacy_typed', 'pos_v1_day_feed'] as const;
export type SalesDaySource = (typeof SALES_DAY_SOURCES)[number];

export const posV1StoreLinks = pgTable(
  'pos_v1_store_links',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** POS's own (Firestore) store id - what the bridge is called with. Never the v2 store id. */
    posStoreId: text('pos_store_id').notNull(),
    /** Display only. */
    posStoreName: text('pos_store_name').notNull(),
    /** The channel POS's sales land in: this store's, remitted daily. */
    salesChannelId: uuid('sales_channel_id')
      .notNull()
      .references(() => salesChannels.id, { onDelete: 'restrict' }),
    /** Copied by the admin from POS's store settings (V9). `vat_exclusive` is refused at import. */
    posTaxType: text('pos_tax_type', { enum: POS_V1_TAX_TYPES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => persons.id, { onDelete: 'restrict' }),
    /** T-382 (0187): a soft unlink. All three NULL on a live link; set together (R10 CHECK). A store is LINKED when its row is LIVE. */
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    unlinkedBy: uuid('unlinked_by').references(() => persons.id, { onDelete: 'restrict' }),
    unlinkReason: text('unlink_reason'),
  },
  (t) => [
    unique('pos_v1_store_links_store_id_unique').on(t.storeId),
    // T-424 (migration 0202): the target of pos_terminal_links' same-org composite FK.
    unique('pos_v1_store_links_org_id_id_unique').on(t.orgId, t.id),
    // GLOBAL, not per org: two orgs linking one POS store would import the same sales twice.
    unique('pos_v1_store_links_pos_store_id_unique').on(t.posStoreId),
    index('pos_v1_store_links_org_idx').on(t.orgId),
    check('pos_v1_store_links_pos_tax_type_check', sql`${t.posTaxType} in ('vat_inclusive', 'vat_exclusive', 'non_vat')`),
    check('pos_v1_store_links_pos_store_id_not_blank_check', sql`btrim(${t.posStoreId}) <> ''`),
    check('pos_v1_store_links_pos_store_name_not_blank_check', sql`btrim(${t.posStoreName}) <> ''`),
    check(
      'pos_v1_store_links_unlink_shape_check',
      sql`(${t.unlinkedAt} is null) = (${t.unlinkedBy} is null) and (${t.unlinkedAt} is null) = (${t.unlinkReason} is null)`,
    ),
    check(
      'pos_v1_store_links_unlink_reason_check',
      sql`${t.unlinkReason} is null or (btrim(${t.unlinkReason}) <> '' and char_length(${t.unlinkReason}) <= 500)`,
    ),
    // NOTE: from migration 0187 (T-382) "linked" means a LIVE row (unlinked_at is null); 0185's header says "has a row".
    // sales_day_store_is_linked was replaced there (hand-added: Drizzle cannot say a function).
    // NOTE: a BEFORE UPDATE trigger refusing a change of store_id (pos_v1_store_links_store_fixed) is
    // hand-added in migration 0185 (T-375 S4), not here.,
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pos_v1_store_links_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'pos_v1_store_links_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.unlinkedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pos_v1_store_links_unlinked_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.updatedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pos_v1_store_links_updated_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `sales_channel_id` FK (RLS checks only this row's org_id); references `sales_channels_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.salesChannelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
      name: 'pos_v1_store_links_sales_channel_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const posV1DayFeeds = pgTable(
  'pos_v1_day_feeds',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    businessDate: date('business_date').notNull(),
    kind: text('kind', { enum: POS_V1_FEED_KINDS }).notNull(),
    purpose: text('purpose', { enum: POS_V1_FEED_PURPOSES }).notNull(),
    /** The rows captured together. An import or recheck batch holds BOTH kinds; a usage batch sold_items only. */
    batchId: uuid('batch_id').notNull(),
    /** The POS id actually called (W9): a recheck uses THIS, never the link's current one. */
    posStoreId: text('pos_store_id').notNull(),
    /** The exact response text. */
    body: text('body').notNull(),
    /** `body` as jsonb. */
    payload: jsonb('payload').notNull(),
    /** sha256 hex of `body`. */
    contentHash: text('content_hash').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    fetchedBy: uuid('fetched_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('pos_v1_day_feeds_batch_id_kind_unique').on(t.batchId, t.kind),
    check('pos_v1_day_feeds_kind_check', sql`${t.kind} in ('sales', 'sold_items')`),
    check('pos_v1_day_feeds_purpose_check', sql`${t.purpose} in ('import', 'recheck', 'usage')`),
    check('pos_v1_day_feeds_content_hash_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('pos_v1_day_feeds_pos_store_id_not_blank_check', sql`btrim(${t.posStoreId}) <> ''`),
    // NOTE: the pos_v1_day_feeds_append_only trigger (refuses UPDATE and DELETE) is hand-added in migration 0183.
    index('pos_v1_day_feeds_store_day_kind_fetched_idx').on(t.orgId, t.storeId, t.businessDate, t.kind, sql`${t.fetchedAt} desc`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.fetchedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'pos_v1_day_feeds_fetched_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'pos_v1_day_feeds_store_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: pos_v1_day_feeds_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES pos_v1_day_feeds (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);

export const tenders = pgTable(
  'tenders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: TENDER_KINDS }).notNull(),
    /** Required iff `kind = 'wallet'`. Same ORG by the composite FK below; same STORE by the domain. */
    moneyAccountId: uuid('money_account_id'),
    /** How POS v1 names it; nullable; dropped at P2. Normalized (lowercase, a-z0-9 only) it is the identity. */
    posV1Alias: text('pos_v1_alias'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // T-472 S1, migration 0216 - the target of pos_bridge_receipt_tenders' same-org composite FK (id alone is already unique).
    unique('tenders_org_id_id_unique').on(t.orgId, t.id),
    index('tenders_org_store_idx').on(t.orgId, t.storeId),
    check('tenders_kind_check', sql`${t.kind} in ('cash', 'wallet')`),
    check('tenders_wallet_account_shape_check', sql`(${t.kind} = 'wallet') = (${t.moneyAccountId} is not null)`),
    check('tenders_name_not_blank_check', sql`btrim(${t.name}) <> ''`),
    check('tenders_pos_v1_alias_not_blank_check', sql`${t.posV1Alias} is null or btrim(${t.posV1Alias}) <> ''`),
    check(
      'tenders_pos_v1_alias_normalizes_check',
      sql`${t.posV1Alias} is null or regexp_replace(lower(${t.posV1Alias}), '[^a-z0-9]', '', 'g') <> ''`,
    ),
    // T-357 / 0171's shape: the single-column FK would accept another org's account. MATCH SIMPLE: a cash tender's
    // NULL account skips it.
    foreignKey({
      columns: [t.orgId, t.moneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'tenders_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: tenders_store_name_unique UNIQUE (store_id, lower(btrim(name))) - all rows, active or not, the
    // `sales_channels` precedent (sales-days.ts) - is an expression index hand-added in migration 0183.
    // NOTE: tenders_store_alias_active_unique UNIQUE (store_id, regexp_replace(lower(pos_v1_alias), '[^a-z0-9]', '', 'g'))
    // WHERE is_active AND pos_v1_alias IS NOT NULL is hand-added in migration 0183 (R3: the normalized alias is the
    // identity among a store's ACTIVE tenders). Do NOT restore a builder uniqueIndex here.,
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'tenders_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const salesDayPosCorrections = pgTable(
  'sales_day_pos_corrections',
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
    /** The basis feed at the time. */
    fromFeedId: uuid('from_feed_id')
      .notNull()
      .references(() => posV1DayFeeds.id, { onDelete: 'restrict' }),
    toFeedId: uuid('to_feed_id')
      .notNull()
      .references(() => posV1DayFeeds.id, { onDelete: 'restrict' }),
    entryDate: date('entry_date').notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    reason: text('reason').notNull(),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sales_day_pos_corrections_day_to_feed_unique').on(t.salesDayId, t.toFeedId),
    index('sales_day_pos_corrections_org_day_idx').on(t.orgId, t.salesDayId),
    check('sales_day_pos_corrections_reason_not_blank_check', sql`btrim(${t.reason}) <> ''`),
    // The default name would exceed 63 characters and be truncated, so it is named here and in 0183.
    foreignKey({
      columns: [t.journalEntryId],
      foreignColumns: [journalEntries.id],
      name: 'sales_day_pos_corrections_journal_entry_id_fk',
    }).onDelete('restrict'),
    // NOTE: the sales_day_pos_corrections_append_only trigger (refuses UPDATE and DELETE) is hand-added in migration 0183.,
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.postedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'sales_day_pos_corrections_posted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'sales_day_pos_corrections_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `from_feed_id` FK (RLS checks only this row's org_id); references `pos_v1_day_feeds_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.fromFeedId],
      foreignColumns: [posV1DayFeeds.orgId, posV1DayFeeds.id],
      name: 'sales_day_pos_corrections_from_feed_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'sales_day_pos_corrections_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `sales_day_id` FK (RLS checks only this row's org_id); references `sales_days_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.salesDayId],
      foreignColumns: [salesDays.orgId, salesDays.id],
      name: 'sales_day_pos_corrections_sales_day_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `to_feed_id` FK (RLS checks only this row's org_id); references `pos_v1_day_feeds_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.toFeedId],
      foreignColumns: [posV1DayFeeds.orgId, posV1DayFeeds.id],
      name: 'sales_day_pos_corrections_to_feed_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
