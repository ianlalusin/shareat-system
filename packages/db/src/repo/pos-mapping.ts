/**
 * The only place SQL is written for POS item mapping and the daily usage pull. T-177.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
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

export interface UpsertMapValues {
  readonly orgId: string;
  readonly storeId: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly mode: PosMapMode;
  readonly itemId: string | null;
  readonly recipeId: string | null;
  readonly quantityPerSale: string | null;
  readonly locationId: string | null;
  readonly createdBy: string;
}

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
    .where(inArray(productionRecipeLines.recipeId, [...recipeIds]));

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
};

/** Any pull that is not void — the uniqueness this repo enforces (pos-mapping.ts schema header). */
export async function findLivePullForDay(tx: Tx, storeId: string, salesDayId: string): Promise<PosUsagePullRow | undefined> {
  const [row] = await tx
    .select(pullColumns)
    .from(posUsagePulls)
    .where(and(eq(posUsagePulls.storeId, storeId), eq(posUsagePulls.salesDayId, salesDayId), ne(posUsagePulls.status, 'void')));
  return row;
}

export async function getPull(tx: Tx, id: string): Promise<PosUsagePullRow | undefined> {
  const [row] = await tx.select(pullColumns).from(posUsagePulls).where(eq(posUsagePulls.id, id));
  return row;
}

export async function insertPull(
  tx: Tx,
  input: { orgId: string; storeId: string; salesDayId: string; locationId: string; snapshotTakenAt: Date },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(posUsagePulls)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      salesDayId: input.salesDayId,
      locationId: input.locationId,
      snapshotTakenAt: input.snapshotTakenAt,
    })
    .returning({ id: posUsagePulls.id });
  return row!;
}

export async function refreshPlannedPull(tx: Tx, id: string, input: { locationId: string; snapshotTakenAt: Date }): Promise<void> {
  await tx
    .update(posUsagePulls)
    .set({ locationId: input.locationId, snapshotTakenAt: input.snapshotTakenAt })
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
export interface InsertPullLine {
  readonly section: PosUsagePullSection;
  readonly lineKey: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly itemId: string | null;
  readonly locationId: string | null;
  readonly quantity: string | null;
  readonly blocked: { reason: string } | null;
}

export async function replacePullLines(tx: Tx, pullId: string, lines: readonly InsertPullLine[]): Promise<void> {
  await tx.delete(posUsagePullLines).where(eq(posUsagePullLines.pullId, pullId));
  if (lines.length === 0) return;
  await tx.insert(posUsagePullLines).values(
    lines.map((l) => ({
      pullId,
      section: l.section,
      lineKey: l.lineKey,
      posItemKey: l.posItemKey,
      posItemName: l.posItemName,
      itemId: l.itemId,
      locationId: l.locationId,
      quantity: l.quantity,
      blocked: l.blocked,
    })),
  );
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

/** Best-effort: a key the fresh rebuild produced that the stored plan does not have (e.g. a brand
 *  new POS item) simply matches zero rows — never a caller's problem, since it was never in
 *  `confirmedKeys` either (the client can only confirm what it was shown). */
export async function setLineUsageRecord(
  tx: Tx,
  pullId: string,
  updates: readonly { lineKey: string; quantity: string; usageRecordId: string }[],
): Promise<void> {
  for (const u of updates) {
    await tx
      .update(posUsagePullLines)
      .set({ quantity: u.quantity, usageRecordId: u.usageRecordId })
      .where(and(eq(posUsagePullLines.pullId, pullId), eq(posUsagePullLines.lineKey, u.lineKey)));
  }
}
