/**
 * The only place SQL is written for POS item mapping and the daily usage pull. T-177.
 */
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { salesDays } from '../../schema/sales-days';
import { stockUsageRecords } from '../../schema/stock-usage';
import type { Decimal, Quantity } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';
import { items } from '../../schema/items';
import { productionRecipeLines, productionRecipes } from '../../schema/production';
import {
  posItemMaps,
  posMapRequests,
  posUsagePullLines,
  posUsagePulls,
  type PosMapMode,
  type PosMapRequestStatus,
  type PosMapStatus,
  type PosUsagePullSection,
  type PosUsagePullStatus,
} from '../../schema/pos-mapping';

// ---------------------------------------------------------------------------------------------
// pos_item_maps
// ---------------------------------------------------------------------------------------------
export interface PosItemMapRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly mode: PosMapMode;
  readonly itemId: string | null;
  readonly recipeId: string | null;
  readonly quantityPerSale: string | null;
  readonly locationId: string | null;
  readonly status: PosMapStatus;
}

const mapColumns = {
  id: posItemMaps.id,
  orgId: posItemMaps.orgId,
  storeId: posItemMaps.storeId,
  posItemKey: posItemMaps.posItemKey,
  posItemName: posItemMaps.posItemName,
  mode: posItemMaps.mode,
  itemId: posItemMaps.itemId,
  recipeId: posItemMaps.recipeId,
  quantityPerSale: posItemMaps.quantityPerSale,
  locationId: posItemMaps.locationId,
  status: posItemMaps.status,
};

export async function listActiveMaps(tx: Tx, storeId: string): Promise<PosItemMapRow[]> {
  return tx
    .select(mapColumns)
    .from(posItemMaps)
    .where(and(eq(posItemMaps.storeId, storeId), eq(posItemMaps.status, 'active')));
}

export async function listMapsForStore(tx: Tx, storeId: string): Promise<PosItemMapRow[]> {
  return tx.select(mapColumns).from(posItemMaps).where(eq(posItemMaps.storeId, storeId));
}

export async function getActiveMapByKey(tx: Tx, storeId: string, posItemKey: string): Promise<PosItemMapRow | undefined> {
  const [row] = await tx
    .select(mapColumns)
    .from(posItemMaps)
    .where(and(eq(posItemMaps.storeId, storeId), eq(posItemMaps.posItemKey, posItemKey), eq(posItemMaps.status, 'active')));
  return row;
}

export async function getMapById(tx: Tx, mapId: string): Promise<PosItemMapRow | undefined> {
  const [row] = await tx.select(mapColumns).from(posItemMaps).where(eq(posItemMaps.id, mapId));
  return row;
}

/** Another ACTIVE 'direct' map already targeting this item, in this store — invariant 8's check.
 *  `excludeMapId` lets an edit compare against every OTHER row without tripping on itself. */
export async function findOtherActiveDirectMapByItem(
  tx: Tx,
  storeId: string,
  itemId: string,
  excludeMapId: string | null,
): Promise<PosItemMapRow | undefined> {
  const conditions = [
    eq(posItemMaps.storeId, storeId),
    eq(posItemMaps.status, 'active'),
    eq(posItemMaps.mode, 'direct'),
    eq(posItemMaps.itemId, itemId),
  ];
  if (excludeMapId) conditions.push(ne(posItemMaps.id, excludeMapId));
  const [row] = await tx.select(mapColumns).from(posItemMaps).where(and(...conditions));
  return row;
}

/** T-371 C2 — `quantityPerSale` is a `Decimal` brand of its column's own (14,6) shape, minted by `decimal()`. */
export type UpsertMapValues = Readonly<
  Pick<SafeInsert<typeof posItemMaps>, 'orgId' | 'storeId' | 'posItemKey' | 'posItemName' | 'createdBy'> & {
    mode: PosMapMode;
    itemId: string | null;
    recipeId: string | null;
    quantityPerSale: Decimal<'14,6'> | null;
    locationId: string | null;
  }
>;

export async function insertMap(tx: Tx, input: UpsertMapValues): Promise<{ id: string }> {
  const [row] = await tx
    .insert(posItemMaps)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      posItemKey: input.posItemKey,
      posItemName: input.posItemName,
      mode: input.mode,
      itemId: input.itemId,
      recipeId: input.recipeId,
      quantityPerSale: input.quantityPerSale,
      locationId: input.locationId,
      createdBy: input.createdBy,
    })
    .returning({ id: posItemMaps.id });
  return row!;
}

export async function updateMap(tx: Tx, mapId: string, input: Omit<UpsertMapValues, 'orgId' | 'storeId' | 'createdBy'>): Promise<void> {
  await tx
    .update(posItemMaps)
    .set({
      posItemName: input.posItemName,
      mode: input.mode,
      itemId: input.itemId,
      recipeId: input.recipeId,
      quantityPerSale: input.quantityPerSale,
      locationId: input.locationId,
      updatedAt: sql`now()`,
    })
    .where(eq(posItemMaps.id, mapId));
}

// ---------------------------------------------------------------------------------------------
// pos_map_requests
// ---------------------------------------------------------------------------------------------
export interface PosMapRequestRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly note: string | null;
  readonly status: PosMapRequestStatus;
  readonly requestedBy: string;
}

const requestColumns = {
  id: posMapRequests.id,
  orgId: posMapRequests.orgId,
  storeId: posMapRequests.storeId,
  posItemKey: posMapRequests.posItemKey,
  posItemName: posMapRequests.posItemName,
  note: posMapRequests.note,
  status: posMapRequests.status,
  requestedBy: posMapRequests.requestedBy,
};

export async function findOpenRequest(tx: Tx, storeId: string, posItemKey: string): Promise<PosMapRequestRow | undefined> {
  const [row] = await tx
    .select(requestColumns)
    .from(posMapRequests)
    .where(and(eq(posMapRequests.storeId, storeId), eq(posMapRequests.posItemKey, posItemKey), eq(posMapRequests.status, 'requested')));
  return row;
}

export async function listRequestsForStore(tx: Tx, storeId: string): Promise<PosMapRequestRow[]> {
  return tx.select(requestColumns).from(posMapRequests).where(eq(posMapRequests.storeId, storeId));
}

export async function getRequestById(tx: Tx, requestId: string): Promise<PosMapRequestRow | undefined> {
  const [row] = await tx.select(requestColumns).from(posMapRequests).where(eq(posMapRequests.id, requestId));
  return row;
}

export async function insertRequest(
  tx: Tx,
  input: { orgId: string; storeId: string; posItemKey: string; posItemName: string; note: string | null; requestedBy: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(posMapRequests)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      posItemKey: input.posItemKey,
      posItemName: input.posItemName,
      note: input.note,
      requestedBy: input.requestedBy,
    })
    .returning({ id: posMapRequests.id });
  return row!;
}

export async function decideRequest(
  tx: Tx,
  requestId: string,
  input: { status: 'approved' | 'rejected'; decidedBy: string; decisionNote: string | null },
): Promise<void> {
  await tx
    .update(posMapRequests)
    .set({ status: input.status, decidedBy: input.decidedBy, decidedAt: sql`now()`, decisionNote: input.decisionNote })
    .where(eq(posMapRequests.id, requestId));
}

// ---------------------------------------------------------------------------------------------
// production_recipes / production_recipe_lines — a narrow, POS-pull-specific projection. Mirrors
// `repo/production.ts`'s own "a second small query rather than widening a shared file" precedent.
// ---------------------------------------------------------------------------------------------
export interface RecipeForExplosion {
  readonly id: string;
  readonly status: string;
  readonly outputQuantity: string;
  readonly lines: readonly { itemId: string; quantity: string; unit: string; itemBaseUnit: string }[];
}

export async function getRecipesForExplosion(tx: Tx, orgId: string, recipeIds: readonly string[]): Promise<RecipeForExplosion[]> {
  if (recipeIds.length === 0) return [];
  const recipeRows = await tx
    .select({ id: productionRecipes.id, status: productionRecipes.status, outputQuantity: productionRecipes.outputQuantity })
    .from(productionRecipes)
    .where(and(eq(productionRecipes.orgId, orgId), inArray(productionRecipes.id, [...recipeIds])));

  const lineRows = await tx
    .select({
      recipeId: productionRecipeLines.recipeId,
      itemId: productionRecipeLines.itemId,
      quantity: productionRecipeLines.quantity,
      unit: productionRecipeLines.unit,
      itemBaseUnit: items.baseUnit,
    })
    .from(productionRecipeLines)
    .innerJoin(items, eq(items.id, productionRecipeLines.itemId))
    .where(inArray(productionRecipeLines.recipeId, [...recipeIds]))
    // DEF-622: the plan keys an ingredient line by its INDEX, so the read order must not be heap order. Line ids are
    // `uuidv7()` (time-ordered), so id order is the order the lines were written.
    .orderBy(productionRecipeLines.id);

  return recipeRows.map((r) => ({
    id: r.id,
    status: r.status,
    outputQuantity: r.outputQuantity,
    lines: lineRows.filter((l) => l.recipeId === r.id).map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit, itemBaseUnit: l.itemBaseUnit })),
  }));
}

// ---------------------------------------------------------------------------------------------
// pos_usage_pulls
// ---------------------------------------------------------------------------------------------
export interface PosUsagePullRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly salesDayId: string;
  readonly locationId: string;
  readonly snapshotTakenAt: Date;
  readonly status: PosUsagePullStatus;
  readonly directFinalizedAt: Date | null;
  readonly recipeFinalizedAt: Date | null;
  readonly orphanFinalizedAt: Date | null;
  /** T-375 S5: the stored `sold_items` feed this plan was built from; null on a pull made before S5-lite. */
  readonly posV1DayFeedId: string | null;
}

const pullColumns = {
  id: posUsagePulls.id,
  orgId: posUsagePulls.orgId,
  storeId: posUsagePulls.storeId,
  salesDayId: posUsagePulls.salesDayId,
  locationId: posUsagePulls.locationId,
  snapshotTakenAt: posUsagePulls.snapshotTakenAt,
  status: posUsagePulls.status,
  directFinalizedAt: posUsagePulls.directFinalizedAt,
  recipeFinalizedAt: posUsagePulls.recipeFinalizedAt,
  orphanFinalizedAt: posUsagePulls.orphanFinalizedAt,
  posV1DayFeedId: posUsagePulls.posV1DayFeedId,
};

/** Any pull that is not void — the uniqueness this repo enforces (pos-mapping.ts schema header). */
export async function findLivePullForDay(tx: Tx, storeId: string, salesDayId: string): Promise<PosUsagePullRow | undefined> {
  const [row] = await tx
    .select(pullColumns)
    .from(posUsagePulls)
    .where(and(eq(posUsagePulls.storeId, storeId), eq(posUsagePulls.salesDayId, salesDayId), ne(posUsagePulls.status, 'void')));
  return row;
}

/**
 * T-373 S1 (R7): a pull of this store on a VOIDED sales day of this business date that has POSTED usage
 * (its direct or recipe section is finalized; the orphan section has no stock effect). Keyed on what was
 * posted, not on the pull's status: a merely planned pull posts nothing and must not block the
 * replacement day, while a pull with one section finalized is the real double count.
 */
export async function findLivePullOnVoidedDayForDate(tx: Tx, storeId: string, businessDate: string): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: posUsagePulls.id })
    .from(posUsagePulls)
    .innerJoin(salesDays, eq(salesDays.id, posUsagePulls.salesDayId))
    .where(
      and(
        eq(posUsagePulls.storeId, storeId),
        ne(posUsagePulls.status, 'void'),
        or(isNotNull(posUsagePulls.directFinalizedAt), isNotNull(posUsagePulls.recipeFinalizedAt)),
        eq(salesDays.status, 'voided'),
        eq(salesDays.businessDate, businessDate),
      ),
    )
    .limit(1);
  return row;
}

/** T-373 S1: which of these sales days carry a non-void pull (the picker keeps a voided one that does). */
export async function listDayIdsWithLivePull(tx: Tx, storeId: string, salesDayIds: readonly string[]): Promise<Set<string>> {
  if (salesDayIds.length === 0) return new Set();
  const rows = await tx
    .select({ salesDayId: posUsagePulls.salesDayId })
    .from(posUsagePulls)
    .where(and(eq(posUsagePulls.storeId, storeId), ne(posUsagePulls.status, 'void'), inArray(posUsagePulls.salesDayId, [...salesDayIds])));
  return new Set(rows.map((r) => r.salesDayId));
}

export async function getPull(tx: Tx, id: string): Promise<PosUsagePullRow | undefined> {
  const [row] = await tx.select(pullColumns).from(posUsagePulls).where(eq(posUsagePulls.id, id));
  return row;
}

export async function insertPull(
  tx: Tx,
  input: { orgId: string; storeId: string; salesDayId: string; locationId: string; snapshotTakenAt: Date; posV1DayFeedId: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(posUsagePulls)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      salesDayId: input.salesDayId,
      locationId: input.locationId,
      snapshotTakenAt: input.snapshotTakenAt,
      posV1DayFeedId: input.posV1DayFeedId,
    })
    .returning({ id: posUsagePulls.id });
  return row!;
}

export async function refreshPlannedPull(tx: Tx, id: string, input: { locationId: string; snapshotTakenAt: Date; posV1DayFeedId: string }): Promise<void> {
  await tx
    .update(posUsagePulls)
    .set({ locationId: input.locationId, snapshotTakenAt: input.snapshotTakenAt, posV1DayFeedId: input.posV1DayFeedId })
    .where(and(eq(posUsagePulls.id, id), eq(posUsagePulls.status, 'planned')));
}

export async function markSectionFinalized(tx: Tx, pullId: string, section: PosUsagePullSection): Promise<void> {
  const now = sql`now()`;
  switch (section) {
    case 'direct':
      await tx.update(posUsagePulls).set({ directFinalizedAt: now }).where(eq(posUsagePulls.id, pullId));
      return;
    case 'recipe':
      await tx.update(posUsagePulls).set({ recipeFinalizedAt: now }).where(eq(posUsagePulls.id, pullId));
      return;
    case 'orphan':
      await tx.update(posUsagePulls).set({ orphanFinalizedAt: now }).where(eq(posUsagePulls.id, pullId));
      return;
  }
}

export async function markPullFinalized(tx: Tx, pullId: string, finalizedBy: string): Promise<void> {
  await tx.update(posUsagePulls).set({ status: 'finalized', finalizedAt: sql`now()`, finalizedBy }).where(eq(posUsagePulls.id, pullId));
}

// ---------------------------------------------------------------------------------------------
// pos_usage_pull_lines
// ---------------------------------------------------------------------------------------------
/** T-371 C2 — `quantity` is a (14,3) `Quantity` brand, minted by `decimal()`. */
export type InsertPullLine = Readonly<
  Pick<SafeInsert<typeof posUsagePullLines>, 'lineKey' | 'posItemKey' | 'posItemName'> & {
    section: PosUsagePullSection;
    itemId: string | null;
    locationId: string | null;
    quantity: Quantity | null;
    blocked: { reason: string } | null;
  }
>;

export async function replacePullLines(
  tx: Tx,
  pullId: string,
  allLines: readonly InsertPullLine[],
  /** T-374 S7: sections already finalized on this pull. Their lines (and links) are left exactly as they are. */
  keepSections: readonly PosUsagePullSection[] = [],
): Promise<void> {
  // Defence in depth: a line that carries a usage record is the only link from the pull to posted stock. Never
  // drop it (a void and R10 both read it), and never duplicate its key. A finalized section is not rewritten.
  const keep = [...keepSections];
  await tx
    .delete(posUsagePullLines)
    .where(
      and(
        eq(posUsagePullLines.pullId, pullId),
        isNull(posUsagePullLines.usageRecordId),
        keep.length > 0 ? notInArray(posUsagePullLines.section, keep) : undefined,
      ),
    );
  const kept = await tx.select({ lineKey: posUsagePullLines.lineKey }).from(posUsagePullLines).where(eq(posUsagePullLines.pullId, pullId));
  const keptKeys = new Set(kept.map((k) => k.lineKey));
  const lines = allLines.filter((l) => !keptKeys.has(l.lineKey) && !keep.includes(l.section));
  if (lines.length === 0) return;
  const rows: (SafeInsert<typeof posUsagePullLines> & { quantity: Quantity | null })[] = lines.map(
    (l) => ({
      pullId,
      section: l.section,
      lineKey: l.lineKey,
      posItemKey: l.posItemKey,
      posItemName: l.posItemName,
      itemId: l.itemId,
      locationId: l.locationId,
      quantity: l.quantity,
      blocked: l.blocked,
    }),
  );
  await tx.insert(posUsagePullLines).values(rows);
}

export interface PullLineRow {
  readonly id: string;
  readonly section: PosUsagePullSection;
  readonly lineKey: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly itemId: string | null;
  readonly locationId: string | null;
  readonly quantity: string | null;
  readonly usageRecordId: string | null;
  readonly blocked: { reason: string } | null;
}

export async function listPullLines(tx: Tx, pullId: string): Promise<PullLineRow[]> {
  const rows = await tx
    .select({
      id: posUsagePullLines.id,
      section: posUsagePullLines.section,
      lineKey: posUsagePullLines.lineKey,
      posItemKey: posUsagePullLines.posItemKey,
      posItemName: posUsagePullLines.posItemName,
      itemId: posUsagePullLines.itemId,
      locationId: posUsagePullLines.locationId,
      quantity: posUsagePullLines.quantity,
      usageRecordId: posUsagePullLines.usageRecordId,
      blocked: posUsagePullLines.blocked,
    })
    .from(posUsagePullLines)
    .where(eq(posUsagePullLines.pullId, pullId));
  return rows as PullLineRow[];
}

/**
 * T-388 R10: link every posted line to its usage record, AS POSTED. It writes `item_id`, `location_id` and
 * `quantity` (what the usage record really holds, which may differ from the plan-time row after a recipe or map
 * edit) with `usage_record_id`. Returns, per update and in order, how many rows it matched: the caller throws an
 * internal fault unless every one is exactly 1 (a posted line left unlinked would be posted a second time by the
 * next finalize). The repo does not throw so the raw-throw ratchet for `packages/db/src/repo` stays where it is.
 */
export async function setLineUsageRecord(
  tx: Tx,
  pullId: string,
  updates: readonly { lineKey: string; itemId: string; locationId: string; quantity: Quantity; usageRecordId: string }[],
): Promise<number[]> {
  const matched: number[] = [];
  for (const u of updates) {
    const hit = await tx
      .update(posUsagePullLines)
      .set({ itemId: u.itemId, locationId: u.locationId, quantity: u.quantity, usageRecordId: u.usageRecordId })
      .where(and(eq(posUsagePullLines.pullId, pullId), eq(posUsagePullLines.lineKey, u.lineKey)))
      .returning({ id: posUsagePullLines.id });
    matched.push(hit.length);
  }
  return matched;
}

/** T-388 R9: does any line of this pull carry a usage record? (A pull with a posted line is "partly finalized".) */
export async function hasPostedLine(tx: Tx, pullId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: posUsagePullLines.id })
    .from(posUsagePullLines)
    .where(and(eq(posUsagePullLines.pullId, pullId), isNotNull(posUsagePullLines.usageRecordId)))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// T-374 S7 (DEF-578): voiding a pull
// ---------------------------------------------------------------------------------------------
/** R9: the pull row under `FOR UPDATE`. A void and a finalize of the same pull serialize here. */
export async function getPullForUpdate(tx: Tx, id: string): Promise<PosUsagePullRow | undefined> {
  const [row] = await tx.select(pullColumns).from(posUsagePulls).where(eq(posUsagePulls.id, id)).for('update');
  return row;
}

/** R13: the pull goes `void` with who, when and why (the DB's `pos_usage_pulls_void_shape_check` insists on all three). */
export async function markPullVoid(tx: Tx, id: string, voidedBy: string, reason: string): Promise<void> {
  await tx
    .update(posUsagePulls)
    .set({ status: 'void', voidedAt: sql`now()`, voidedBy, voidReason: reason })
    .where(eq(posUsagePulls.id, id));
}

/** The distinct usage records this pull made that are still `posted`, in id order (stable, so the void is repeatable). */
export async function postedUsageRecordIdsForPull(tx: Tx, pullId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: stockUsageRecords.id })
    .from(posUsagePullLines)
    .innerJoin(stockUsageRecords, eq(stockUsageRecords.id, posUsagePullLines.usageRecordId))
    .where(and(eq(posUsagePullLines.pullId, pullId), eq(stockUsageRecords.status, 'posted')))
    .orderBy(stockUsageRecords.id);
  return rows.map((r) => r.id);
}

/** R10: the non-void pull, with its sales day's business date, that links this usage record; none when no live pull does. */
export async function livePullForUsageRecord(tx: Tx, recordId: string): Promise<{ pullId: string; businessDate: string } | undefined> {
  const [row] = await tx
    .select({ pullId: posUsagePulls.id, businessDate: salesDays.businessDate })
    .from(posUsagePullLines)
    .innerJoin(posUsagePulls, eq(posUsagePulls.id, posUsagePullLines.pullId))
    .innerJoin(salesDays, eq(salesDays.id, posUsagePulls.salesDayId))
    .where(and(eq(posUsagePullLines.usageRecordId, recordId), ne(posUsagePulls.status, 'void')))
    .limit(1);
  return row;
}

/** T-401 S5: the business dates (oldest first) of this store's pulls still in status `planned`: a rule or a source must not move under them. */
export async function listPlannedPullDates(tx: Tx, storeId: string): Promise<string[]> {
  const rows = await tx
    .select({ businessDate: salesDays.businessDate })
    .from(posUsagePulls)
    .innerJoin(salesDays, eq(salesDays.id, posUsagePulls.salesDayId))
    .where(and(eq(posUsagePulls.storeId, storeId), eq(posUsagePulls.status, 'planned')))
    .orderBy(salesDays.businessDate);
  return [...new Set(rows.map((r) => r.businessDate))];
}

/** T-401 S5 (read-only): the location a store's non-void pull of each business date used. A date with no live pull is absent. */
export async function liveUsageLocationsByDate(tx: Tx, storeId: string, businessDates: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (businessDates.length === 0) return out;
  const rows = await tx
    .select({ businessDate: salesDays.businessDate, locationId: posUsagePulls.locationId })
    .from(posUsagePulls)
    .innerJoin(salesDays, eq(salesDays.id, posUsagePulls.salesDayId))
    .where(and(eq(posUsagePulls.storeId, storeId), ne(posUsagePulls.status, 'void'), inArray(salesDays.businessDate, [...businessDates])))
    .orderBy(posUsagePulls.id);
  for (const r of rows) out.set(r.businessDate, r.locationId);
  return out;
}
