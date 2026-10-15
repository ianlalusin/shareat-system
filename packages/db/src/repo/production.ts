/**
 * The only place SQL is written for production recipes and records. T-176.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Money, Quantity } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';
import { items } from '../../schema/items';
import {
  productionRecipeLines,
  productionRecipes,
  productionRecordLines,
  productionRecords,
  type ProductionKind,
  type ProductionLineDirection,
  type ProductionRecipeStatus,
  type ProductionStatus,
} from '../../schema/production';

// ---------------------------------------------------------------------------------------------
// Items — a narrow, production-specific projection. `items.ts`'s own `ItemRow`/`getItemById`
// (packages/db/src/repo/items.ts) predate `parent_slab_item_id` and are outside this lane's
// scope to edit; this is a second, deliberately small query rather than widening a shared file.
// ---------------------------------------------------------------------------------------------
export interface ProductionItemRow {
  readonly id: string;
  readonly orgId: string;
  /** T-409: named in the slice-category refusal sentences. */
  readonly name: string;
  readonly kind: string;
  readonly baseUnit: string;
  readonly status: string;
  readonly parentSlabItemId: string | null;
}

export async function getItemForProduction(tx: Tx, orgId: string, id: string): Promise<ProductionItemRow | undefined> {
  const [row] = await tx
    .select({
      id: items.id,
      orgId: items.orgId,
      name: items.name,
      kind: items.kind,
      baseUnit: items.baseUnit,
      status: items.status,
      parentSlabItemId: items.parentSlabItemId,
    })
    .from(items)
    .where(and(eq(items.id, id), eq(items.orgId, orgId)));
  return row;
}

export async function getItemsForProduction(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<ProductionItemRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: items.id,
      orgId: items.orgId,
      name: items.name,
      kind: items.kind,
      baseUnit: items.baseUnit,
      status: items.status,
      parentSlabItemId: items.parentSlabItemId,
    })
    .from(items)
    .where(and(eq(items.orgId, orgId), inArray(items.id, [...ids])));
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------
export interface RecipeRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly outputItemId: string;
  readonly outputQuantity: string;
  readonly status: ProductionRecipeStatus;
}

/** T-371 C2 — `outputQuantity` is a `Decimal<'14,3'>` minted by `decimal()`. */
export type InsertRecipeInput = Required<
  Pick<SafeInsert<typeof productionRecipes>, 'orgId' | 'name' | 'outputItemId' | 'createdBy'>
> & { outputQuantity: Quantity };

export async function insertRecipe(tx: Tx, input: InsertRecipeInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(productionRecipes)
    .values({
      orgId: input.orgId,
      name: input.name,
      outputItemId: input.outputItemId,
      outputQuantity: input.outputQuantity,
      createdBy: input.createdBy,
    })
    .returning({ id: productionRecipes.id });
  return row!;
}

/** T-371 C2 — one recipe line; `quantity` is a `Decimal<'14,3'>`. */
export type InsertRecipeLineInput = Required<Pick<SafeInsert<typeof productionRecipeLines>, 'itemId' | 'unit'>> & {
  quantity: Quantity;
};

export async function insertRecipeLines(
  tx: Tx,
  recipeId: string,
  lines: readonly InsertRecipeLineInput[],
): Promise<{ id: string }[]> {
  if (lines.length === 0) return [];
  const rows: (SafeInsert<typeof productionRecipeLines> & { quantity: Quantity })[] = lines.map((l) => ({
    recipeId,
    itemId: l.itemId,
    quantity: l.quantity,
    unit: l.unit,
  }));
  return tx
    .insert(productionRecipeLines)
    .values(rows)
    .returning({ id: productionRecipeLines.id });
}

export async function getRecipe(tx: Tx, orgId: string, id: string): Promise<RecipeRow | undefined> {
  const [row] = await tx
    .select({
      id: productionRecipes.id,
      orgId: productionRecipes.orgId,
      name: productionRecipes.name,
      outputItemId: productionRecipes.outputItemId,
      outputQuantity: productionRecipes.outputQuantity,
      status: productionRecipes.status,
    })
    .from(productionRecipes)
    .where(and(eq(productionRecipes.id, id), eq(productionRecipes.orgId, orgId)));
  return row;
}

export async function listRecipes(tx: Tx, orgId: string, includeInactive = false): Promise<RecipeRow[]> {
  const conditions = [eq(productionRecipes.orgId, orgId)];
  if (!includeInactive) conditions.push(eq(productionRecipes.status, 'active'));
  return tx
    .select({
      id: productionRecipes.id,
      orgId: productionRecipes.orgId,
      name: productionRecipes.name,
      outputItemId: productionRecipes.outputItemId,
      outputQuantity: productionRecipes.outputQuantity,
      status: productionRecipes.status,
    })
    .from(productionRecipes)
    .where(and(...conditions))
    .orderBy(asc(productionRecipes.name));
}

export interface RecipeLineRow {
  readonly id: string;
  readonly recipeId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly unit: string;
}

export async function listRecipeLines(tx: Tx, recipeId: string): Promise<RecipeLineRow[]> {
  return tx
    .select({
      id: productionRecipeLines.id,
      recipeId: productionRecipeLines.recipeId,
      itemId: productionRecipeLines.itemId,
      quantity: productionRecipeLines.quantity,
      unit: productionRecipeLines.unit,
    })
    .from(productionRecipeLines)
    .where(eq(productionRecipeLines.recipeId, recipeId));
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------
export interface ProductionRecordRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly kind: ProductionKind;
  readonly recipeId: string | null;
  readonly status: ProductionStatus;
  readonly revision: number;
  readonly producedOn: string;
  readonly softWarnings: unknown;
  readonly labourCost: string;
  readonly journalEntryId: string | null;
  readonly createdBy: string;
}

/**
 * T-371 C2 — `labourCost` is a `Decimal<'14,2'>` minted by `decimal()`.
 * ✎R13 `labour_cost` is NOT NULL DEFAULT '0': a blank is OMITTED so the column default applies.
 */
export type InsertProductionRecordInput = Required<
  Pick<
    SafeInsert<typeof productionRecords>,
    'orgId' | 'storeId' | 'locationId' | 'kind' | 'producedOn' | 'createdBy'
  >
> & {
  recipeId: string | null;
  /** Omit for the column default ('0'). */
  labourCost?: Money;
};

export async function insertProductionRecord(tx: Tx, input: InsertProductionRecordInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(productionRecords)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      kind: input.kind,
      recipeId: input.recipeId,
      producedOn: input.producedOn,
      // ✎R13 `undefined` is skipped by Drizzle, so the column default applies.
      labourCost: input.labourCost,
      createdBy: input.createdBy,
    })
    .returning({ id: productionRecords.id });
  return row!;
}

export async function getProductionRecord(tx: Tx, id: string): Promise<ProductionRecordRow | undefined> {
  const [row] = await tx
    .select({
      id: productionRecords.id,
      orgId: productionRecords.orgId,
      storeId: productionRecords.storeId,
      locationId: productionRecords.locationId,
      kind: productionRecords.kind,
      recipeId: productionRecords.recipeId,
      status: productionRecords.status,
      revision: productionRecords.revision,
      producedOn: productionRecords.producedOn,
      softWarnings: productionRecords.softWarnings,
      labourCost: productionRecords.labourCost,
      journalEntryId: productionRecords.journalEntryId,
      createdBy: productionRecords.createdBy,
    })
    .from(productionRecords)
    .where(eq(productionRecords.id, id));
  return row as ProductionRecordRow | undefined;
}

export async function listProductionRecords(
  tx: Tx,
  storeId: string,
  filter: { status?: ProductionStatus } = {},
): Promise<ProductionRecordRow[]> {
  const conditions = [eq(productionRecords.storeId, storeId)];
  if (filter.status) conditions.push(eq(productionRecords.status, filter.status));
  const rows = await tx
    .select({
      id: productionRecords.id,
      orgId: productionRecords.orgId,
      storeId: productionRecords.storeId,
      locationId: productionRecords.locationId,
      kind: productionRecords.kind,
      recipeId: productionRecords.recipeId,
      status: productionRecords.status,
      revision: productionRecords.revision,
      producedOn: productionRecords.producedOn,
      softWarnings: productionRecords.softWarnings,
      labourCost: productionRecords.labourCost,
      journalEntryId: productionRecords.journalEntryId,
      createdBy: productionRecords.createdBy,
    })
    .from(productionRecords)
    .where(and(...conditions))
    .orderBy(desc(productionRecords.producedOn), desc(productionRecords.createdAt));
  return rows as ProductionRecordRow[];
}

export async function markProductionPosted(
  tx: Tx,
  id: string,
  journalEntryId: string | null,
  postedBy: string,
  softWarnings: readonly string[],
): Promise<void> {
  await tx
    .update(productionRecords)
    .set({
      status: 'posted',
      journalEntryId,
      postedAt: new Date(),
      postedBy,
      softWarnings,
    })
    .where(eq(productionRecords.id, id));
}

export async function markProductionVoid(tx: Tx, id: string, voidedBy: string, voidReason: string): Promise<void> {
  await tx
    .update(productionRecords)
    .set({ status: 'void', voidedAt: new Date(), voidedBy, voidReason })
    .where(eq(productionRecords.id, id));
}

/** Edit-in-place: bump `revision` and repoint at the new journal entry (null for a `convert`,
 *  which never carries one — the CHECK enforces that; this call simply passes null for one). */
export async function bumpProductionRevision(
  tx: Tx,
  id: string,
  newRevision: number,
  journalEntryId: string | null,
): Promise<void> {
  await tx
    .update(productionRecords)
    .set({ revision: newRevision, journalEntryId })
    .where(eq(productionRecords.id, id));
}

// ---------------------------------------------------------------------------------------------
// Record lines
// ---------------------------------------------------------------------------------------------
export interface ProductionRecordLineRow {
  readonly id: string;
  readonly recordId: string;
  readonly direction: ProductionLineDirection;
  readonly itemId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly movementId: string | null;
  readonly revision: number;
  readonly reversedAt: Date | null;
}

/** T-371 C2 — one record line; `quantity` is a `Decimal<'14,3'>`. */
export type InsertProductionRecordLineInput = Required<
  Pick<SafeInsert<typeof productionRecordLines>, 'itemId' | 'unit'>
> & { direction: ProductionLineDirection; quantity: Quantity };

export async function insertProductionRecordLines(
  tx: Tx,
  recordId: string,
  revision: number,
  lines: readonly InsertProductionRecordLineInput[],
): Promise<ProductionRecordLineRow[]> {
  if (lines.length === 0) return [];
  const values: (SafeInsert<typeof productionRecordLines> & { quantity: Quantity })[] = lines.map((l) => ({
    recordId,
    direction: l.direction,
    itemId: l.itemId,
    quantity: l.quantity,
    unit: l.unit,
    revision,
  }));
  const rows = await tx.insert(productionRecordLines).values(values).returning();
  return rows as ProductionRecordLineRow[];
}

export async function listProductionRecordLines(
  tx: Tx,
  recordId: string,
  filter: { revision?: number; unreversedOnly?: boolean } = {},
): Promise<ProductionRecordLineRow[]> {
  const conditions = [eq(productionRecordLines.recordId, recordId)];
  if (filter.revision !== undefined) conditions.push(eq(productionRecordLines.revision, filter.revision));
  if (filter.unreversedOnly) conditions.push(sql`${productionRecordLines.reversedAt} is null`);
  const rows = await tx
    .select()
    .from(productionRecordLines)
    .where(and(...conditions))
    .orderBy(asc(productionRecordLines.createdAt));
  return rows as ProductionRecordLineRow[];
}

export async function setLineMovement(tx: Tx, lineId: string, movementId: string): Promise<void> {
  await tx.update(productionRecordLines).set({ movementId }).where(eq(productionRecordLines.id, lineId));
}

export async function markLinesReversed(tx: Tx, lineIds: readonly string[]): Promise<void> {
  if (lineIds.length === 0) return;
  await tx
    .update(productionRecordLines)
    .set({ reversedAt: new Date() })
    .where(inArray(productionRecordLines.id, [...lineIds]));
}
