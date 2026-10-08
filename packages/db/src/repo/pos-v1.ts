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
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { POS_V1_SALES_FIELDS, POS_V1_SOLD_ITEMS_FIELDS } from '../pos-v1/wire';
import {
  posV1DayFeeds,
  posV1StoreLinks,
  salesDayPosCorrections,
  tenders,
  type PosV1FeedKind,
  type PosV1FeedPurpose,
  type PosV1TaxType,
  type TenderKind,
} from '../../schema/pos-v1';
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
  /** T-382: set while the link is unlinked (all three or none). */
  readonly unlinkedAt: Date | null;
  readonly unlinkedBy: string | null;
  readonly unlinkReason: string | null;
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
  unlinkedAt: posV1StoreLinks.unlinkedAt,
  unlinkedBy: posV1StoreLinks.unlinkedBy,
  unlinkReason: posV1StoreLinks.unlinkReason,
};

/** The LIVE link of one store, or undefined when the store is not linked or was unlinked (the per-store switch, T-382). */
export async function getLinkByStore(tx: Tx, orgId: string, storeId: string): Promise<PosV1StoreLinkRow | undefined> {
  const [row] = await tx
    .select(linkColumns)
    .from(posV1StoreLinks)
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId), isNull(posV1StoreLinks.unlinkedAt)))
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

/** The link (live OR unlinked: T-382 REV-1, a POS id stays held by its store) that names this POS store, with the v2 store's name (for "already linked to {store}"). */
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

/** The LIVE link whose sales channel this is - the channel guard's read (V6). An unlinked row no longer guards its channel (T-382). */
export async function getLinkByChannel(tx: Tx, orgId: string, salesChannelId: string): Promise<PosV1StoreLinkRow | undefined> {
  const [row] = await tx
    .select(linkColumns)
    .from(posV1StoreLinks)
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.salesChannelId, salesChannelId), isNull(posV1StoreLinks.unlinkedAt)))
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

/** A relink: never `store_id` (0185 refuses it, and nothing here offers it). T-382 R8: it also clears the unlink. */
export async function updateLink(tx: Tx, orgId: string, storeId: string, patch: UpdateLinkInput): Promise<void> {
  await tx
    .update(posV1StoreLinks)
    .set({ ...patch, updatedAt: sql`now()`, unlinkedAt: null, unlinkedBy: null, unlinkReason: null })
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId)));
}

/** T-382 R11: unlink the store's LIVE link. Sets the three columns, nothing else. Returns whether a live row was updated. */
export async function unlink(
  tx: Tx,
  orgId: string,
  storeId: string,
  input: { readonly unlinkedBy: string; readonly reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(posV1StoreLinks)
    .set({ unlinkedAt: sql`now()`, unlinkedBy: input.unlinkedBy, unlinkReason: input.reason })
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId), isNull(posV1StoreLinks.unlinkedAt)))
    .returning({ id: posV1StoreLinks.id });
  return rows.length > 0;
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

/** T-382 R3: business dates of the store's open or submitted IMPORTED days, oldest first (these block an unlink). */
export async function unverifiedFeedDates(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = await tx
    .select({ businessDate: salesDays.businessDate })
    .from(salesDays)
    .where(
      and(
        eq(salesDays.orgId, orgId),
        eq(salesDays.storeId, storeId),
        eq(salesDays.source, 'pos_v1_day_feed'),
        inArray(salesDays.status, ['open', 'submitted']),
      ),
    )
    .orderBy(asc(salesDays.businessDate));
  return rows.map((r) => r.businessDate);
}

/** T-382 R11: how many verified imported days the store holds (the unlink banner's count). */
export async function countVerifiedFeedDays(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(salesDays)
    .where(
      and(
        eq(salesDays.orgId, orgId),
        eq(salesDays.storeId, storeId),
        eq(salesDays.source, 'pos_v1_day_feed'),
        eq(salesDays.status, 'verified'),
      ),
    );
  return row?.n ?? 0;
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
  /** When the responses arrived (one value for the whole batch). Absent = the database's `now()`. */
  readonly fetchedAt?: Date;
  /** One entry per kind captured together: an import/recheck batch holds BOTH kinds, a usage batch sold_items only. */
  readonly rows: readonly { readonly kind: PosV1FeedKind; readonly body: string; readonly payload: unknown }[];
}

/**
 * Insert one batch (one `batch_id`, one row per kind), in the order given. `fetched_at` is the database's `now()`:
 * every row of a batch shares one `fetchedAt` (the caller's, or the transaction's clock). Returns the ids by kind.
 */
export async function insertBatch(
  tx: Tx,
  input: InsertFeedBatchInput,
): Promise<{ batchId: string; ids: Partial<Record<PosV1FeedKind, string>>; fetchedAt: Date }> {
  const batchId = crypto.randomUUID();
  const ids: Partial<Record<PosV1FeedKind, string>> = {};
  let stamped: Date | undefined;
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
        ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
      })
      .returning({ id: posV1DayFeeds.id, fetchedAt: posV1DayFeeds.fetchedAt });
    ids[r.kind] = row!.id;
    stamped ??= row!.fetchedAt;
  }
  return { batchId, ids, fetchedAt: stamped! };
}

/**
 * T-382 R10 (DEF-607): the NAME of another store of the org whose feeds were fetched from this POS store id, if any.
 * Any `pos_v1_day_feeds` row counts (live link or not, relinked away or not): those sales are already booked there.
 */
export async function otherStoreImportedFromPos(
  tx: Tx,
  orgId: string,
  posStoreId: string,
  storeId: string,
): Promise<{ storeId: string; storeName: string } | undefined> {
  const [row] = await tx
    .select({ storeId: posV1DayFeeds.storeId, storeName: stores.name })
    .from(posV1DayFeeds)
    .innerJoin(stores, eq(stores.id, posV1DayFeeds.storeId))
    .where(and(eq(posV1DayFeeds.orgId, orgId), eq(posV1DayFeeds.posStoreId, posStoreId), ne(posV1DayFeeds.storeId, storeId)))
    .limit(1);
  return row;
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
 * The BASIS feed of a feed-sourced day (R10): the `to_feed_id` of the day's latest correction, else the `sales` feed
 * the day was derived from (`pos_v1_day_feed_id`). A day with neither has no basis (a typed day).
 */
export async function basisFor(tx: Tx, orgId: string, salesDayId: string): Promise<PosV1DayFeedRow | undefined> {
  const [day] = await tx
    .select({ feedId: salesDays.posV1DayFeedId })
    .from(salesDays)
    .where(and(eq(salesDays.orgId, orgId), eq(salesDays.id, salesDayId), ne(salesDays.source, 'legacy_typed')))
    .limit(1);
  if (!day?.feedId) return undefined;
  const latest = await latestCorrection(tx, orgId, salesDayId);
  return getFeedById(tx, orgId, latest ? latest.toFeedId : day.feedId);
}

// ---------------------------------------------------------------------------------------------
// sales_day_pos_corrections (T-375 S6) - append-only
// ---------------------------------------------------------------------------------------------
export interface PosCorrectionRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly salesDayId: string;
  readonly fromFeedId: string;
  readonly toFeedId: string;
  readonly entryDate: string;
  readonly journalEntryId: string;
  readonly reason: string;
  readonly postedBy: string;
  readonly postedAt: Date;
}

const correctionColumns = {
  id: salesDayPosCorrections.id,
  orgId: salesDayPosCorrections.orgId,
  storeId: salesDayPosCorrections.storeId,
  salesDayId: salesDayPosCorrections.salesDayId,
  fromFeedId: salesDayPosCorrections.fromFeedId,
  toFeedId: salesDayPosCorrections.toFeedId,
  entryDate: salesDayPosCorrections.entryDate,
  journalEntryId: salesDayPosCorrections.journalEntryId,
  reason: salesDayPosCorrections.reason,
  postedBy: salesDayPosCorrections.postedBy,
  postedAt: salesDayPosCorrections.postedAt,
};

/** A day's corrections, oldest first. */
export async function listCorrectionsForDay(tx: Tx, orgId: string, salesDayId: string): Promise<PosCorrectionRow[]> {
  return tx
    .select(correctionColumns)
    .from(salesDayPosCorrections)
    .where(and(eq(salesDayPosCorrections.orgId, orgId), eq(salesDayPosCorrections.salesDayId, salesDayId)))
    .orderBy(asc(salesDayPosCorrections.postedAt), asc(salesDayPosCorrections.id));
}

export async function latestCorrection(tx: Tx, orgId: string, salesDayId: string): Promise<PosCorrectionRow | undefined> {
  const [row] = await tx
    .select(correctionColumns)
    .from(salesDayPosCorrections)
    .where(and(eq(salesDayPosCorrections.orgId, orgId), eq(salesDayPosCorrections.salesDayId, salesDayId)))
    .orderBy(desc(salesDayPosCorrections.postedAt), desc(salesDayPosCorrections.id))
    .limit(1);
  return row;
}

export async function findCorrectionByToFeed(
  tx: Tx,
  orgId: string,
  salesDayId: string,
  toFeedId: string,
): Promise<PosCorrectionRow | undefined> {
  const [row] = await tx
    .select(correctionColumns)
    .from(salesDayPosCorrections)
    .where(
      and(
        eq(salesDayPosCorrections.orgId, orgId),
        eq(salesDayPosCorrections.salesDayId, salesDayId),
        eq(salesDayPosCorrections.toFeedId, toFeedId),
      ),
    )
    .limit(1);
  return row;
}

export interface InsertCorrectionInput {
  /** Chosen by the caller: the correction's journal entry names it as its `source_id` and is posted first. */
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly salesDayId: string;
  readonly fromFeedId: string;
  readonly toFeedId: string;
  readonly entryDate: string;
  readonly journalEntryId: string;
  readonly reason: string;
  readonly postedBy: string;
}

export async function insertCorrection(tx: Tx, input: InsertCorrectionInput): Promise<void> {
  // `posted_at` is the statement's own clock, not the transaction's `now()`, so corrections order exactly by when they were
  // written even if two share a transaction. (`id` is not an ordering key here: the caller's uuid is random.)
  await tx.insert(salesDayPosCorrections).values({ ...input, postedAt: sql`clock_timestamp()` });
}

export interface PostedNetRow {
  readonly accountCode: string;
  readonly partyType: string | null;
  readonly partyId: string | null;
  /** debit minus credit, summed over the given entries (numeric text, may be negative). */
  readonly net: string;
}

/** What the given entries POSTED, netted per (account, party): the "old" side of a correction (V7). */
export async function postedNetForEntries(tx: Tx, orgId: string, entryIds: readonly string[]): Promise<PostedNetRow[]> {
  if (entryIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    select a.code as account_code, jl.party_type as party_type, jl.party_id::text as party_id,
           sum(jl.debit - jl.credit)::numeric(14,2)::text as net
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
     where je.org_id = ${orgId}
       and jl.entry_id in (${sql.join(entryIds.map((id) => sql`${id}::uuid`), sql`, `)})
     group by a.code, jl.party_type, jl.party_id
  `)) as unknown as { account_code: string; party_type: string | null; party_id: string | null; net: string }[];
  return rows.map((r) => ({ accountCode: r.account_code, partyType: r.party_type, partyId: r.party_id, net: r.net }));
}

// ---------------------------------------------------------------------------------------------
// drift (T-375 S6, R10): the projections are built from the wire constants
// ---------------------------------------------------------------------------------------------
// Wire keys are bound parameters (`payload -> $key`), never spliced text: the names live in `wire.ts` only (R12).
const feedPayload = (alias: 'basis' | 'latest' | 'pin') => sql`${sql.identifier(alias)}.payload`;

const salesField = (alias: 'basis' | 'latest' | 'pin', k: keyof typeof POS_V1_SALES_FIELDS) => {
  const key = POS_V1_SALES_FIELDS[k];
  return sql`(case when jsonb_typeof(${feedPayload(alias)} -> ${key}::text) = 'number' then (${feedPayload(alias)} ->> ${key}::text)::numeric else 0 end)`;
};

/** The MONEY projection of a `sales` feed row (P, K, D, C, the methods map); the receipt count and the body are not in it. */
function salesMoneyProjection(alias: 'basis' | 'latest') {
  const methods = sql`(${feedPayload(alias)} -> ${POS_V1_SALES_FIELDS.methods}::text)`;
  return sql`jsonb_build_object(
    'found', (${feedPayload(alias)} ->> ${POS_V1_SALES_FIELDS.found}::text) = 'true',
    'p', ${salesField(alias, 'paidTotal')},
    'k', ${salesField(alias, 'packageOnly')},
    'd', ${salesField(alias, 'discounts')},
    'c', ${salesField(alias, 'charges')},
    -- method keys are normalized as the tender resolver normalizes aliases (lowercase, a-z0-9 only), and methods that
    -- collapse to one key are summed (the resolver sums methods resolving to one tender): a relabel is not drift.
    'm', coalesce((
      select jsonb_object_agg(n.k, n.v) from (
        select regexp_replace(lower(m.key), '[^a-z0-9]', '', 'g') as k,
               sum(case when jsonb_typeof(m.value) = 'number' then (m.value)::text::numeric else 0 end) as v
          from jsonb_each(case when jsonb_typeof(${methods}) = 'object' then ${methods} else '{}'::jsonb end) m
         group by 1
        having sum(case when jsonb_typeof(m.value) = 'number' then (m.value)::text::numeric else 0 end) <> 0
      ) n
    ), '{}'::jsonb))`;
}

/** The ITEMS projection of a `sold_items` feed row: physical quantity per item key (names, order, other fields ignored). */
function itemsProjection(alias: 'latest' | 'pin') {
  const items = sql`(${feedPayload(alias)} -> ${POS_V1_SOLD_ITEMS_FIELDS.items}::text)`;
  const key = POS_V1_SOLD_ITEMS_FIELDS.itemKey;
  const qty = POS_V1_SOLD_ITEMS_FIELDS.physicalQty;
  return sql`coalesce((
    select jsonb_object_agg(t.k, t.q) from (
      select e ->> ${key}::text as k,
             sum(case when jsonb_typeof(e -> ${qty}::text) = 'number' then (e ->> ${qty}::text)::numeric else 0 end) as q
        from jsonb_array_elements(case when jsonb_typeof(${items}) = 'array' then ${items} else '[]'::jsonb end) e
       where e ->> ${key}::text is not null
       group by 1
    ) t
  ), '{}'::jsonb)`;
}

export interface FeedDriftRow {
  readonly salesDayId: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly businessDate: string;
  /** The day's latest `sales` feed (the one a correction would be posted from). */
  readonly latestFeedId: string;
  /** POS's paid total in the basis feed and in the latest one (numeric(14,2) text). */
  readonly paidThen: string;
  readonly paidNow: string;
}

/**
 * Verified feed days whose latest `sales` feed is newer than the day's basis and differs in the MONEY projection
 * (R10). `salesDayId` narrows it to one day. An open or submitted day is never listed (it re-imports).
 */
export async function feedDrift(tx: Tx, orgId: string, salesDayId?: string): Promise<FeedDriftRow[]> {
  const rows = (await tx.execute(sql`
    select d.id::text as sales_day_id, d.store_id::text as store_id, s.name as store_name,
           d.business_date::text as business_date, latest.id::text as latest_feed_id,
           (${salesField('basis', 'paidTotal')})::numeric(14,2)::text as paid_then,
           (${salesField('latest', 'paidTotal')})::numeric(14,2)::text as paid_now
      from sales_days d
      join stores s on s.id = d.store_id
      join pos_v1_day_feeds basis on basis.id = coalesce(
        (select c.to_feed_id from sales_day_pos_corrections c where c.sales_day_id = d.id order by c.posted_at desc, c.id desc limit 1),
        d.pos_v1_day_feed_id)
      join lateral (
        select l.* from pos_v1_day_feeds l
         where l.org_id = d.org_id and l.store_id = d.store_id and l.business_date = d.business_date and l.kind = 'sales'
         order by l.fetched_at desc, l.id desc limit 1
      ) latest on true
     where d.org_id = ${orgId}
       ${salesDayId ? sql`and d.id = ${salesDayId}` : sql``}
       and d.status = 'verified'
       and d.source = 'pos_v1_day_feed'
       and (latest.fetched_at, latest.id) > (basis.fetched_at, basis.id)
       and ${salesMoneyProjection('latest')} <> ${salesMoneyProjection('basis')}
     order by d.business_date, d.id
  `)) as unknown as {
    sales_day_id: string; store_id: string; store_name: string; business_date: string; latest_feed_id: string; paid_then: string; paid_now: string;
  }[];
  return rows.map((r) => ({
    salesDayId: r.sales_day_id,
    storeId: r.store_id,
    storeName: r.store_name,
    businessDate: r.business_date,
    latestFeedId: r.latest_feed_id,
    paidThen: r.paid_then,
    paidNow: r.paid_now,
  }));
}

export interface SoldItemsDriftRow {
  readonly pullId: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly businessDate: string;
}

/**
 * Usage pulls with ANY finalized section (status `finalized`, or a section stamped) whose pinned `sold_items` feed is
 * older than the day's latest `sold_items` feed, where the two differ in the items projection (R10, S5L-R).
 */
export async function soldItemsDrift(tx: Tx, orgId: string): Promise<SoldItemsDriftRow[]> {
  const rows = (await tx.execute(sql`
    select p.id::text as pull_id, p.store_id::text as store_id, s.name as store_name, d.business_date::text as business_date
      from pos_usage_pulls p
      join sales_days d on d.id = p.sales_day_id
      join stores s on s.id = p.store_id
      join pos_v1_day_feeds pin on pin.id = p.pos_v1_day_feed_id
      join lateral (
        select l.* from pos_v1_day_feeds l
         where l.org_id = d.org_id and l.store_id = d.store_id and l.business_date = d.business_date and l.kind = 'sold_items'
         order by l.fetched_at desc, l.id desc limit 1
      ) latest on true
     where p.org_id = ${orgId}
       and p.status <> 'void'
       and (p.status = 'finalized' or p.direct_finalized_at is not null or p.recipe_finalized_at is not null or p.orphan_finalized_at is not null)
       and (latest.fetched_at, latest.id) > (pin.fetched_at, pin.id)
       and ${itemsProjection('latest')} <> ${itemsProjection('pin')}
     order by d.business_date, p.id
  `)) as unknown as { pull_id: string; store_id: string; store_name: string; business_date: string }[];
  return rows.map((r) => ({ pullId: r.pull_id, storeId: r.store_id, storeName: r.store_name, businessDate: r.business_date }));
}

/** The store's verified feed days in the `days` days before `beforeDate`, newest first. */
export async function verifiedFeedDaysBefore(
  tx: Tx,
  orgId: string,
  storeId: string,
  beforeDate: string,
  days: number,
): Promise<{ id: string; businessDate: string }[]> {
  const rows = (await tx.execute(sql`
    select d.id::text as id, d.business_date::text as business_date
      from sales_days d
     where d.org_id = ${orgId} and d.store_id = ${storeId}
       and d.status = 'verified' and d.source = 'pos_v1_day_feed'
       and d.business_date < ${beforeDate}::date
       and d.business_date >= (${beforeDate}::date - ${days}::int)
     order by d.business_date desc
  `)) as unknown as { id: string; business_date: string }[];
  return rows.map((r) => ({ id: r.id, businessDate: r.business_date }));
}

// ---------------------------------------------------------------------------------------------
// tenders (T-375 S2)
// ---------------------------------------------------------------------------------------------
export interface TenderRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly name: string;
  readonly kind: TenderKind;
  readonly moneyAccountId: string | null;
  readonly posV1Alias: string | null;
  readonly isActive: boolean;
  /** R1: microseconds of coalesce(updated_at, created_at), as text. A fresh row (updated_at NULL) still has one. */
  readonly version: string;
}

const tenderVersionSql = sql<string>`(extract(epoch from coalesce(${tenders.updatedAt}, ${tenders.createdAt})) * 1000000)::bigint::text`;

const tenderColumns = {
  id: tenders.id,
  orgId: tenders.orgId,
  storeId: tenders.storeId,
  name: tenders.name,
  kind: tenders.kind,
  moneyAccountId: tenders.moneyAccountId,
  posV1Alias: tenders.posV1Alias,
  isActive: tenders.isActive,
  version: tenderVersionSql.as('version'),
};

export async function getTenderById(tx: Tx, orgId: string, id: string): Promise<TenderRow | undefined> {
  const [row] = await tx
    .select(tenderColumns)
    .from(tenders)
    .where(and(eq(tenders.orgId, orgId), eq(tenders.id, id)))
    .limit(1);
  return row;
}

/** The tender row under `FOR UPDATE` (an edit reads the row it is about to change). */
export async function getTenderByIdForUpdate(tx: Tx, orgId: string, id: string): Promise<TenderRow | undefined> {
  const [row] = await tx
    .select(tenderColumns)
    .from(tenders)
    .where(and(eq(tenders.orgId, orgId), eq(tenders.id, id)))
    .limit(1)
    .for('update');
  return row;
}

/** Every tender of one store, active or not, by name. */
export async function listTendersByStore(tx: Tx, orgId: string, storeId: string): Promise<TenderRow[]> {
  return tx
    .select(tenderColumns)
    .from(tenders)
    .where(and(eq(tenders.orgId, orgId), eq(tenders.storeId, storeId)))
    .orderBy(asc(tenders.name));
}

/**
 * The store's ACTIVE tender whose alias normalizes (lowercase, a-z0-9 only) to `normalizedAlias`, other than
 * `exceptId`. The same normalization as the `tenders_store_alias_active_unique` index (R3).
 */
export async function findActiveTenderByAlias(
  tx: Tx,
  orgId: string,
  storeId: string,
  normalizedAlias: string,
  exceptId?: string,
): Promise<TenderRow | undefined> {
  const conds = [
    eq(tenders.orgId, orgId),
    eq(tenders.storeId, storeId),
    eq(tenders.isActive, true),
    sql`regexp_replace(lower(${tenders.posV1Alias}), '[^a-z0-9]', '', 'g') = ${normalizedAlias}`,
  ];
  if (exceptId) conds.push(ne(tenders.id, exceptId));
  const [row] = await tx.select(tenderColumns).from(tenders).where(and(...conds)).limit(1);
  return row;
}

export interface InsertTenderInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly name: string;
  readonly kind: TenderKind;
  readonly moneyAccountId: string | null;
  readonly posV1Alias: string | null;
}

export async function insertTender(tx: Tx, input: InsertTenderInput): Promise<{ id: string }> {
  const [row] = await tx.insert(tenders).values(input).returning({ id: tenders.id });
  return row!;
}

export interface UpdateTenderPatch {
  readonly name?: string;
  readonly kind?: TenderKind;
  readonly posV1Alias?: string | null;
  readonly moneyAccountId?: string | null;
  readonly isActive?: boolean;
}

/**
 * Returns the number of rows changed. With `expectedVersion` the row is written only if its version still equals it
 * (R1), so 0 means "changed since the page was drawn" (or gone).
 */
export async function updateTenderRow(
  tx: Tx,
  orgId: string,
  id: string,
  patch: UpdateTenderPatch,
  expectedVersion?: string,
): Promise<number> {
  const conds = [eq(tenders.orgId, orgId), eq(tenders.id, id)];
  if (expectedVersion !== undefined) conds.push(sql`${tenderVersionSql} = ${expectedVersion}`);
  const rows = await tx
    .update(tenders)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(...conds))
    .returning({ id: tenders.id });
  return rows.length;
}
