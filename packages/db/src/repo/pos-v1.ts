/**
 * The only place SQL is written for the POS v1 day feed. T-375 S1 (migration 0183), `docs/tasks/375-pos-v1-day-feed.md`.
 *
 * S1 holds the links and the feeds. Tenders arrive with S2, corrections with S6 - the tables exist (0183) and the
 * functions are added by the slice that first needs them.
 *
 * Every read is org-scoped explicitly as well as by RLS (an id from another org reads as absent). Nothing here
 * updates or deletes a feed row: the table is append-only by trigger and by grant (I6).
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { posV1DayFeeds, posV1StoreLinks, type PosV1FeedKind, type PosV1FeedPurpose, type PosV1TaxType } from '../../schema/pos-v1';
import { salesChannels, salesDays } from '../../schema/sales-days';
import { stores } from '../../schema/stores';

// ---------------------------------------------------------------------------------------------
// pos_v1_store_links
// ---------------------------------------------------------------------------------------------
export interface PosV1StoreLinkRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly posStoreId: string;
  readonly posStoreName: string;
  readonly salesChannelId: string;
  readonly posTaxType: PosV1TaxType;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

const linkColumns = {
  id: posV1StoreLinks.id,
  orgId: posV1StoreLinks.orgId,
  storeId: posV1StoreLinks.storeId,
  posStoreId: posV1StoreLinks.posStoreId,
  posStoreName: posV1StoreLinks.posStoreName,
  salesChannelId: posV1StoreLinks.salesChannelId,
  posTaxType: posV1StoreLinks.posTaxType,
  createdAt: posV1StoreLinks.createdAt,
  createdBy: posV1StoreLinks.createdBy,
  updatedAt: posV1StoreLinks.updatedAt,
  updatedBy: posV1StoreLinks.updatedBy,
};

/** The link of one store, or undefined when the store is not linked (the per-store switch is this row). */
export async function getLinkByStore(tx: Tx, orgId: string, storeId: string): Promise<PosV1StoreLinkRow | undefined> {
  const [row] = await tx
    .select(linkColumns)
    .from(posV1StoreLinks)
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId)))
    .limit(1);
  return row;
}

/** As `getLinkByStore`, `FOR UPDATE`: a relink reads the row it is about to change. */
export async function getLinkByStoreForUpdate(tx: Tx, orgId: string, storeId: string): Promise<PosV1StoreLinkRow | undefined> {
  const [row] = await tx
    .select(linkColumns)
    .from(posV1StoreLinks)
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId)))
    .limit(1)
    .for('update');
  return row;
}

/** The link that names this POS store, with the v2 store's name (for "already linked to {store}"). */
export async function getLinkByPosStoreId(
  tx: Tx,
  orgId: string,
  posStoreId: string,
): Promise<(PosV1StoreLinkRow & { storeName: string }) | undefined> {
  const [row] = await tx
    .select({ ...linkColumns, storeName: stores.name })
    .from(posV1StoreLinks)
    .innerJoin(stores, eq(stores.id, posV1StoreLinks.storeId))
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.posStoreId, posStoreId)))
    .limit(1);
  return row;
}

/** The link whose sales channel this is - the channel guard's read (V6). */
export async function getLinkByChannel(tx: Tx, orgId: string, salesChannelId: string): Promise<PosV1StoreLinkRow | undefined> {
  const [row] = await tx
    .select(linkColumns)
    .from(posV1StoreLinks)
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.salesChannelId, salesChannelId)))
    .limit(1);
  return row;
}

export async function listLinks(tx: Tx, orgId: string): Promise<PosV1StoreLinkRow[]> {
  return tx.select(linkColumns).from(posV1StoreLinks).where(eq(posV1StoreLinks.orgId, orgId));
}

export interface InsertLinkInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly posStoreId: string;
  readonly posStoreName: string;
  readonly salesChannelId: string;
  readonly posTaxType: PosV1TaxType;
  readonly createdBy: string;
}

export async function insertLink(tx: Tx, input: InsertLinkInput): Promise<{ id: string }> {
  const [row] = await tx.insert(posV1StoreLinks).values(input).returning({ id: posV1StoreLinks.id });
  return row!;
}

export interface UpdateLinkInput {
  readonly posStoreId: string;
  readonly posStoreName: string;
  readonly salesChannelId: string;
  readonly posTaxType: PosV1TaxType;
  readonly updatedBy: string;
}

/** A relink: never `store_id` (0184 refuses it, and nothing here offers it). */
export async function updateLink(tx: Tx, orgId: string, storeId: string, patch: UpdateLinkInput): Promise<void> {
  await tx
    .update(posV1StoreLinks)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId)));
}

/**
 * The store row under `FOR UPDATE` (R13). `linkStoreToPos` takes this before it reads anything else; a typed
 * `createSalesDay` holds the same row `FOR KEY SHARE`, so the two serialize. Returns the store's name.
 */
export async function lockStoreForUpdate(tx: Tx, orgId: string, storeId: string): Promise<{ id: string; name: string } | undefined> {
  const [row] = await tx
    .select({ id: stores.id, name: stores.name })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)))
    .limit(1)
    .for('update');
  return row;
}

/** The sales channel row under `FOR UPDATE` (defence in depth for the link's channel checks). */
export async function lockChannelForUpdate(tx: Tx, orgId: string, channelId: string): Promise<void> {
  await tx
    .select({ id: salesChannels.id })
    .from(salesChannels)
    .where(and(eq(salesChannels.orgId, orgId), eq(salesChannels.id, channelId)))
    .limit(1)
    .for('update');
}

/** Business dates of the store's open or submitted typed days, oldest first (W6: these block a link). */
export async function unverifiedTypedDates(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = await tx
    .select({ businessDate: salesDays.businessDate })
    .from(salesDays)
    .where(
      and(
        eq(salesDays.orgId, orgId),
        eq(salesDays.storeId, storeId),
        eq(salesDays.source, 'legacy_typed'),
        inArray(salesDays.status, ['open', 'submitted']),
      ),
    )
    .orderBy(asc(salesDays.businessDate));
  return rows.map((r) => r.businessDate);
}

// ---------------------------------------------------------------------------------------------
// pos_v1_day_feeds
// ---------------------------------------------------------------------------------------------
export interface PosV1DayFeedRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly businessDate: string;
  readonly kind: PosV1FeedKind;
  readonly purpose: PosV1FeedPurpose;
  readonly batchId: string;
  readonly posStoreId: string;
  readonly body: string;
  readonly payload: unknown;
  readonly contentHash: string;
  readonly fetchedAt: Date;
  readonly fetchedBy: string;
}

const feedColumns = {
  id: posV1DayFeeds.id,
  orgId: posV1DayFeeds.orgId,
  storeId: posV1DayFeeds.storeId,
  businessDate: posV1DayFeeds.businessDate,
  kind: posV1DayFeeds.kind,
  purpose: posV1DayFeeds.purpose,
  batchId: posV1DayFeeds.batchId,
  posStoreId: posV1DayFeeds.posStoreId,
  body: posV1DayFeeds.body,
  payload: posV1DayFeeds.payload,
  contentHash: posV1DayFeeds.contentHash,
  fetchedAt: posV1DayFeeds.fetchedAt,
  fetchedBy: posV1DayFeeds.fetchedBy,
};

/** sha256 hex of the response text - the column's CHECK shape. */
export function contentHashOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export interface InsertFeedBatchInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly businessDate: string;
  readonly purpose: PosV1FeedPurpose;
  /** POS's own id actually called (W9). */
  readonly posStoreId: string;
  readonly fetchedBy: string;
  /** One entry per kind captured together: an import/recheck batch holds BOTH kinds, a usage batch sold_items only. */
  readonly rows: readonly { readonly kind: PosV1FeedKind; readonly body: string; readonly payload: unknown }[];
}

/**
 * Insert one batch (one `batch_id`, one row per kind), in the order given. `fetched_at` is the database's `now()`:
 * every row of a batch shares the transaction's clock. Returns the ids by kind.
 */
export async function insertBatch(
  tx: Tx,
  input: InsertFeedBatchInput,
): Promise<{ batchId: string; ids: Partial<Record<PosV1FeedKind, string>> }> {
  const batchId = crypto.randomUUID();
  const ids: Partial<Record<PosV1FeedKind, string>> = {};
  for (const r of input.rows) {
    const [row] = await tx
      .insert(posV1DayFeeds)
      .values({
        orgId: input.orgId,
        storeId: input.storeId,
        businessDate: input.businessDate,
        kind: r.kind,
        purpose: input.purpose,
        batchId,
        posStoreId: input.posStoreId,
        body: r.body,
        payload: r.payload,
        contentHash: contentHashOf(r.body),
        fetchedBy: input.fetchedBy,
      })
      .returning({ id: posV1DayFeeds.id });
    ids[r.kind] = row!.id;
  }
  return { batchId, ids };
}

export async function getFeedById(tx: Tx, orgId: string, id: string): Promise<PosV1DayFeedRow | undefined> {
  const [row] = await tx
    .select(feedColumns)
    .from(posV1DayFeeds)
    .where(and(eq(posV1DayFeeds.orgId, orgId), eq(posV1DayFeeds.id, id)))
    .limit(1);
  return row as PosV1DayFeedRow | undefined;
}

/** The day's latest feed of one kind, any purpose (R9: usage reads the latest stored `sold_items`). */
export async function latestForDay(
  tx: Tx,
  orgId: string,
  storeId: string,
  businessDate: string,
  kind: PosV1FeedKind,
): Promise<PosV1DayFeedRow | undefined> {
  const [row] = await tx
    .select(feedColumns)
    .from(posV1DayFeeds)
    .where(
      and(
        eq(posV1DayFeeds.orgId, orgId),
        eq(posV1DayFeeds.storeId, storeId),
        eq(posV1DayFeeds.businessDate, businessDate),
        eq(posV1DayFeeds.kind, kind),
      ),
    )
    .orderBy(desc(posV1DayFeeds.fetchedAt), desc(posV1DayFeeds.id))
    .limit(1);
  return row as PosV1DayFeedRow | undefined;
}

/**
 * The BASIS feed of a feed-sourced day (R10): the `sales` feed the day was derived from. S6 refines this to the
 * `to_feed_id` of the day's latest correction once corrections are written; until then the basis is the day's own
 * `pos_v1_day_feed_id`, and a day with none has no basis.
 */
export async function basisFor(tx: Tx, orgId: string, salesDayId: string): Promise<PosV1DayFeedRow | undefined> {
  const [day] = await tx
    .select({ feedId: salesDays.posV1DayFeedId })
    .from(salesDays)
    .where(and(eq(salesDays.orgId, orgId), eq(salesDays.id, salesDayId), ne(salesDays.source, 'legacy_typed')))
    .limit(1);
  if (!day?.feedId) return undefined;
  return getFeedById(tx, orgId, day.feedId);
}
