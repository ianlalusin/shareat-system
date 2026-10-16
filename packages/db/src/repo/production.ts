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
    .where(eq(productionRecipeLines.recipeId, recipeId))
    .orderBy(productionRecipeLines.id);
}

// ---------------------------------------------------------------------------------------------
// T-413 - recipe admin. Every statement is filtered by org (the repo layer; RLS backstops it).
// ---------------------------------------------------------------------------------------------
/** Header change. `updated_at` is stamped; the status is a separate door (`setRecipeStatus`). */
export async function updateRecipe(
  tx: Tx,
  orgId: string,
  id: string,
  patch: { name: string; outputItemId: string; outputQuantity: Quantity },
): Promise<void> {
  await tx
    .update(productionRecipes)
    .set({ name: patch.name, outputItemId: patch.outputItemId, outputQuantity: patch.outputQuantity, updatedAt: sql`now()` })
    .where(and(eq(productionRecipes.id, id), eq(productionRecipes.orgId, orgId)));
}

/** Replaces every line of a recipe (delete + insert; the caller's transaction makes it one step). The recipe must be the caller's org's. */
export async function replaceRecipeLines(
  tx: Tx,
  orgId: string,
  recipeId: string,
  lines: readonly InsertRecipeLineInput[],
): Promise<void> {
  const own = await getRecipe(tx, orgId, recipeId);
  if (!own) return;
  await tx.delete(productionRecipeLines).where(eq(productionRecipeLines.recipeId, recipeId));
  await insertRecipeLines(tx, recipeId, lines);
}

export async function setRecipeStatus(tx: Tx, orgId: string, id: string, status: ProductionRecipeStatus): Promise<void> {
  await tx
    .update(productionRecipes)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(productionRecipes.id, id), eq(productionRecipes.orgId, orgId)));
}

/** The recipe that holds this name in the org (case ignored, retired recipes included), if any. */
export async function findRecipeByName(tx: Tx, orgId: string, name: string): Promise<{ id: string; status: ProductionRecipeStatus } | undefined> {
  const [row] = await tx
    .select({ id: productionRecipes.id, status: productionRecipes.status })
    .from(productionRecipes)
    .where(and(eq(productionRecipes.orgId, orgId), sql`lower(${productionRecipes.name}) = lower(${name})`));
  return row;
}

export interface RecipeDraftUse {
  readonly storeName: string;
  readonly producedOn: string;
}

/** E1: every unfinished (draft) cook on the recipe, any store, oldest day first. */
export async function listDraftRecordsUsingRecipe(tx: Tx, orgId: string, recipeId: string): Promise<RecipeDraftUse[]> {
  const rows = (await tx.execute(sql`
    select s.name as store_name, r.produced_on::text as produced_on
    from production_records r
    join stores s on s.id = r.store_id
    where r.org_id = ${orgId} and r.recipe_id = ${recipeId} and r.status = 'draft'
    order by r.produced_on, r.id
  `)) as unknown as { store_name: string; produced_on: string }[];
  return rows.map((r) => ({ storeName: r.store_name, producedOn: r.produced_on }));
}

export interface RecipeDependent {
  /** `map`: an active v1 POS item map; `rule`: a menu depletion rule in force or scheduled. */
  readonly kind: 'map' | 'rule';
  /** The POS item's name, or the menu item (and variant) name. */
  readonly name: string;
}

/** R4: the active v1 POS maps and the in-force or scheduled menu rules that name the recipe (maps first, then rules, by name). */
export async function listRecipeDependents(tx: Tx, orgId: string, recipeId: string): Promise<RecipeDependent[]> {
  const maps = (await tx.execute(sql`
    select m.pos_item_name as name
    from pos_item_maps m
    where m.org_id = ${orgId} and m.recipe_id = ${recipeId} and m.status = 'active'
    order by m.pos_item_name, m.id
  `)) as unknown as { name: string }[];
  const rules = (await tx.execute(sql`
    select case when v.label is null then mi.name else mi.name || ' (' || v.label || ')' end as name
    from menu_depletion_rules r
    join menu_item_variants v on v.id = r.variant_id
    join menu_items mi on mi.id = v.menu_item_id
    where r.org_id = ${orgId} and r.recipe_id = ${recipeId}
      and (r.effective_from > now()
           or (r.effective_from <= now()
               and not exists (select 1 from menu_depletion_rules r2
                               where r2.variant_id = r.variant_id and r2.effective_from <= now() and r2.effective_from > r.effective_from)))
    order by 1, r.id
  `)) as unknown as { name: string }[];
  return [...maps.map((m) => ({ kind: 'map' as const, name: m.name })), ...rules.map((m) => ({ kind: 'rule' as const, name: m.name }))];
}

export interface RecipePlannedPull {
  readonly storeName: string;
  readonly businessDate: string;
}

/**
 * E2: the planned usage pulls at stores that use the recipe - an active v1 map names it, or the store reads the menu rules and links
 * a variant whose rule in force names it. A planned pull at a store that does not use the recipe is not listed.
 */
export async function listPlannedPullsUsingRecipe(tx: Tx, orgId: string, recipeId: string): Promise<RecipePlannedPull[]> {
  const rows = (await tx.execute(sql`
    select distinct s.name as store_name, d.business_date::text as business_date, d.business_date as sort_date
    from pos_usage_pulls p
    join sales_days d on d.id = p.sales_day_id
    join stores s on s.id = p.store_id
    where p.org_id = ${orgId} and p.status = 'planned'
      and (
        exists (select 1 from pos_item_maps m
                where m.store_id = p.store_id and m.recipe_id = ${recipeId} and m.status = 'active')
        or exists (select 1
                   from menu_pos_v1_links l
                   join menu_depletion_rules r on r.variant_id = l.variant_id and r.recipe_id = ${recipeId}
                   where l.store_id = p.store_id and l.status = 'active'
                     and coalesce((select sw.source from menu_usage_source_switches sw where sw.store_id = l.store_id
                                   order by sw.created_at desc, sw.id desc limit 1), 'v1_pos_map') = 'menu_rules'
                     and r.effective_from <= now()
                     and not exists (select 1 from menu_depletion_rules r2
                                     where r2.variant_id = r.variant_id and r2.effective_from <= now() and r2.effective_from > r.effective_from))
      )
    order by sort_date, store_name
  `)) as unknown as { store_name: string; business_date: string }[];
  return rows.map((r) => ({ storeName: r.store_name, businessDate: r.business_date }));
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

// ---------------------------------------------------------------------------------------------
// T-419 — ingredients used by recipe cooking, for the daily usage screen (display only)
// ---------------------------------------------------------------------------------------------
export interface CookInputRow {
  readonly recordId: string;
  readonly status: 'draft' | 'posted';
  readonly recipeId: string;
  readonly recipeName: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unit: string;
  readonly locationId: string;
}

/**
 * The ingredients (direction 'out' - the cooked dish is 'in') of the day's cook records at one store, drafts and posted, never void.
 * Only lines not reversed by an edit. Posted first, then recipe name, then item name. One query.
 */
export async function listCookInputsForDay(tx: Tx, orgId: string, storeId: string, producedOn: string): Promise<CookInputRow[]> {
  const rows = (await tx.execute(sql`
    select r.id as record_id, r.status, rc.id as recipe_id, rc.name as recipe_name,
           i.id as item_id, i.code as item_code, i.name as item_name,
           l.quantity::text as quantity, l.unit, r.location_id
      from production_records r
      join production_recipes rc on rc.id = r.recipe_id
      join production_record_lines l on l.record_id = r.id
      join items i on i.id = l.item_id
     where r.org_id = ${orgId}
       and r.store_id = ${storeId}
       and r.produced_on = ${producedOn}
       and r.kind = 'cook'
       and r.status in ('draft', 'posted')
       and l.direction = 'out'
       and l.reversed_at is null
     order by (r.status = 'posted') desc, rc.name, i.name, r.id, l.created_at
  `)) as unknown as {
    record_id: string; status: 'draft' | 'posted'; recipe_id: string; recipe_name: string; item_id: string;
    item_code: string; item_name: string; quantity: string; unit: string; location_id: string;
  }[];
  return rows.map((x) => ({
    recordId: x.record_id, status: x.status, recipeId: x.recipe_id, recipeName: x.recipe_name, itemId: x.item_id,
    itemCode: x.item_code, itemName: x.item_name, quantity: x.quantity, unit: x.unit, locationId: x.location_id,
  }));
}

/**
 * T-420 - what POSTED recipe cooking took out of each item on one day at one store, for the usage check. One query, a `sum(...)::text`,
 * never a float. Counts only `kind = 'cook'`, `status = 'posted'`, `direction = 'out'` (the dish is 'in'), lines not reversed by an edit.
 * `locationId` narrows to cooks in that one room (a pull draft's own room); `itemIds` narrows to those items. Items with no cook are absent.
 */
export async function cookedByItemForDay(
  tx: Tx,
  orgId: string,
  storeId: string,
  producedOn: string,
  opts: { readonly locationId?: string; readonly itemIds?: readonly string[]; readonly skipSnapshotRooms?: boolean } = {},
): Promise<Map<string, string>> {
  if (opts.itemIds && opts.itemIds.length === 0) return new Map();
  const room = opts.locationId ? sql`and r.location_id = ${opts.locationId}` : sql``;
  // A cook in a room whose pull draft holds a snapshot of the item is already credited to THAT snapshot (room scope); the live,
  // store-wide check must not credit it a second time.
  const skip = opts.skipSnapshotRooms
    ? sql`and not exists (
        select 1 from pos_usage_pull_lines pl
          join pos_usage_pulls p on p.id = pl.pull_id
          join stock_usage_records u on u.id = pl.usage_record_id
         where u.store_id = r.store_id and u.used_on = r.produced_on and u.location_id = r.location_id
           and pl.item_id = l.item_id and p.status <> 'void' and u.status <> 'void' and pl.draft_expected_qty is not null)`
    : sql``;
  const only = opts.itemIds ? sql`and l.item_id in (${sql.join(opts.itemIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = (await tx.execute(sql`
    select l.item_id, sum(l.quantity)::text as qty
      from production_records r
      join production_record_lines l on l.record_id = r.id
     where r.org_id = ${orgId}
       and r.store_id = ${storeId}
       and r.produced_on = ${producedOn}
       and r.kind = 'cook'
       and r.status = 'posted'
       and l.direction = 'out'
       and l.reversed_at is null
       ${room}
       ${skip}
       ${only}
     group by l.item_id
  `)) as unknown as { item_id: string; qty: string }[];
  return new Map(rows.map((x) => [x.item_id, x.qty]));
}
