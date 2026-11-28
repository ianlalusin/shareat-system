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
  productionRecipeStores,
  productionRecipes,
  productionRecordLines,
  productionRecords,
  type ProductionKind,
  type ProductionLineDirection,
  type ProductionRecipeStatus,
  type ProductionStatus,
} from '../../schema/production';
import { slicerPayRates } from '../../schema/payroll';

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
  /** T-650 S2: the labour for ONE batch of `outputQuantity`, or null when the recipe carries none. */
  readonly standardLabourCost: string | null;
  readonly status: ProductionRecipeStatus;
}

/** T-371 C2 — `outputQuantity` is a `Decimal<'14,3'>` minted by `decimal()`. */
export type InsertRecipeInput = Required<
  Pick<SafeInsert<typeof productionRecipes>, 'orgId' | 'name' | 'outputItemId' | 'createdBy'>
> & { outputQuantity: Quantity; standardLabourCost?: Money | null };

export async function insertRecipe(tx: Tx, input: InsertRecipeInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(productionRecipes)
    .values({
      orgId: input.orgId,
      name: input.name,
      outputItemId: input.outputItemId,
      outputQuantity: input.outputQuantity,
      standardLabourCost: input.standardLabourCost ?? null,
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
      standardLabourCost: productionRecipes.standardLabourCost,
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
      standardLabourCost: productionRecipes.standardLabourCost,
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
  patch: { name: string; outputItemId: string; outputQuantity: Quantity; standardLabourCost: Money | null },
): Promise<void> {
  await tx
    .update(productionRecipes)
    .set({ name: patch.name, outputItemId: patch.outputItemId, outputQuantity: patch.outputQuantity, standardLabourCost: patch.standardLabourCost, updatedAt: sql`now()` })
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

// ---------------------------------------------------------------------------------------------
// T-650 S2 - the stores a product recipe may be made at. No rows = every store.
// ---------------------------------------------------------------------------------------------
/** The stores a recipe is limited to, by name (empty = no limit). */
export async function listRecipeStores(tx: Tx, orgId: string, recipeId: string): Promise<{ storeId: string; storeName: string }[]> {
  const rows = (await tx.execute(sql`
    select s.id::text as store_id, s.name as store_name
    from production_recipe_stores rs join stores s on s.id = rs.store_id
    where rs.org_id = ${orgId} and rs.recipe_id = ${recipeId}
    order by s.name, s.id
  `)) as unknown as { store_id: string; store_name: string }[];
  return rows.map((r) => ({ storeId: r.store_id, storeName: r.store_name }));
}

/** Every limited recipe's stores in one read: recipe id -> store ids. A recipe missing from the map has no limit. */
export async function recipeStoreMap(tx: Tx, orgId: string): Promise<Map<string, string[]>> {
  const rows = (await tx.execute(sql`
    select recipe_id::text as recipe_id, store_id::text as store_id from production_recipe_stores where org_id = ${orgId} order by recipe_id, store_id
  `)) as unknown as { recipe_id: string; store_id: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.recipe_id, [...(out.get(r.recipe_id) ?? []), r.store_id]);
  return out;
}

/** Replaces a recipe's store list (delete + insert; the caller's transaction makes it one step). An empty list removes the limit. */
export async function replaceRecipeStores(tx: Tx, orgId: string, recipeId: string, storeIds: readonly string[]): Promise<void> {
  await tx.delete(productionRecipeStores).where(and(eq(productionRecipeStores.orgId, orgId), eq(productionRecipeStores.recipeId, recipeId)));
  const unique = [...new Set(storeIds)];
  if (unique.length === 0) return;
  await tx.insert(productionRecipeStores).values(unique.map((storeId) => ({ orgId, recipeId, storeId })));
}

/** The store names of the org, for the "Only X make Y" sentence and the "Made at" picker's validation. Stores of another org are simply absent. */
export async function storeNamesIn(tx: Tx, orgId: string, storeIds: readonly string[]): Promise<Map<string, string>> {
  if (storeIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`select id::text as id, name from stores where org_id = ${orgId} and id in (${sql.join(storeIds.map((s) => sql`${s}`), sql`, `)})`)) as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
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
  /** T-635 (migration 0279). */
  readonly performedByPersonId: string | null;
  readonly confirmedByPersonId: string | null;
  readonly confirmedAt: Date | null;
  readonly paidByPayRunId: string | null;
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
  /** T-635. Who sliced it (slice records); null otherwise. */
  performedByPersonId?: string | null;
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
      performedByPersonId: input.performedByPersonId ?? null,
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
      performedByPersonId: productionRecords.performedByPersonId,
      confirmedByPersonId: productionRecords.confirmedByPersonId,
      confirmedAt: productionRecords.confirmedAt,
      paidByPayRunId: productionRecords.paidByPayRunId,
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
      performedByPersonId: productionRecords.performedByPersonId,
      confirmedByPersonId: productionRecords.confirmedByPersonId,
      confirmedAt: productionRecords.confirmedAt,
      paidByPayRunId: productionRecords.paidByPayRunId,
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
  /** T-650 S1: the labour the new legs were posted with. Stored so the record always says what its journal entry capitalised (an edit used to leave the old figure here). */
  labourCost?: Money,
): Promise<void> {
  await tx
    .update(productionRecords)
    // T-635: an edit changes what was checked, so the confirmation goes (the domain refuses an edit of a PAID record before it gets here).
    .set({ revision: newRevision, journalEntryId, confirmedByPersonId: null, confirmedAt: null, ...(labourCost === undefined ? {} : { labourCost }) })
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
  /** T-635. */
  readonly isPaid: boolean;
}

/** T-371 C2 — one record line; `quantity` is a `Decimal<'14,3'>`. */
export type InsertProductionRecordLineInput = Required<
  Pick<SafeInsert<typeof productionRecordLines>, 'itemId' | 'unit'>
> & { direction: ProductionLineDirection; quantity: Quantity; /** T-635: default true. */ isPaid?: boolean };

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
    isPaid: l.isPaid ?? true,
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

// ---------------------------------------------------------------------------------------------
// T-635 - slicer pay. Who sliced, who confirmed, what a kg pays, and the pay-run freeze.
// ---------------------------------------------------------------------------------------------

/** The employment of `personId` at the store that is open on `on` and holds the canonical Slicer position, or null. Positions are not dated, so "holds Slicer" is read as of today. */
export async function slicerEmploymentOn(tx: Tx, orgId: string, personId: string, storeId: string, on: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select e.id::text as id
      from employments e
      join employment_positions ep on ep.employment_id = e.id
      join positions p on p.id = ep.position_id
     where e.org_id = ${orgId} and e.person_id = ${personId} and e.store_id = ${storeId}
       and e.started_on <= ${on}::date and (e.ended_on is null or e.ended_on >= ${on}::date)
       and p.org_id = ${orgId} and p.name = 'Slicer' and p.is_canonical and p.is_active
     order by e.started_on, e.id
     limit 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/** Confirms a posted, unpaid, unconfirmed slice record. False when nothing matched (someone else got there first). */
export async function confirmRecord(tx: Tx, id: string, confirmedBy: string): Promise<boolean> {
  const rows = await tx
    .update(productionRecords)
    .set({ confirmedByPersonId: confirmedBy, confirmedAt: new Date() })
    .where(and(eq(productionRecords.id, id), sql`${productionRecords.confirmedAt} is null and ${productionRecords.paidByPayRunId} is null`))
    .returning({ id: productionRecords.id });
  return rows.length > 0;
}

/** Takes the confirmation back. False when the record is not confirmed or is already paid. */
export async function unconfirmRecord(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .update(productionRecords)
    .set({ confirmedByPersonId: null, confirmedAt: null })
    .where(and(eq(productionRecords.id, id), sql`${productionRecords.confirmedAt} is not null and ${productionRecords.paidByPayRunId} is null`))
    .returning({ id: productionRecords.id });
  return rows.length > 0;
}

export interface SlicerPayRateRow {
  readonly id: string;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly ratePerKg: string;
  readonly effectiveFrom: string;
  readonly note: string | null;
  readonly createdAt: Date;
}

export async function insertSlicerPayRate(
  tx: Tx,
  input: { orgId: string; itemId: string | null; ratePerKg: Money; effectiveFrom: string; note: string | null; createdBy: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(slicerPayRates)
    .values({
      orgId: input.orgId,
      itemId: input.itemId,
      ratePerKg: input.ratePerKg,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
      createdBy: input.createdBy,
    })
    .returning({ id: slicerPayRates.id });
  return row!;
}

/** Every rate row the org has (newest first), with the item's name. The rate in force is picked by the domain from this list, so the rule lives in one place. */
export async function listSlicerPayRates(tx: Tx, orgId: string): Promise<SlicerPayRateRow[]> {
  const rows = (await tx.execute(sql`
    select r.id::text as id, r.item_id::text as "itemId", i.name as "itemName", r.rate_per_kg::text as "ratePerKg",
           r.effective_from::text as "effectiveFrom", r.note, r.created_at as "createdAt"
      from slicer_pay_rates r
      left join items i on i.id = r.item_id
     where r.org_id = ${orgId}
     order by r.effective_from desc, r.created_at desc, r.id
  `)) as unknown as SlicerPayRateRow[];
  return rows;
}

/** A slice record that may be paid (posted, confirmed, unpaid) by a run for a period: produced on or before the period's end (a late confirmation is paid in the next run, T-635 S2). */
export interface PayableSlicerRecord {
  readonly recordId: string;
  readonly personId: string;
  readonly personName: string;
  readonly producedOn: string;
  /** The employment of that person at the store on that day; null when none (then no slip can carry the pay). */
  readonly employmentId: string | null;
  readonly paidByPayRunId: string | null;
}

export interface SlicerOutputLine {
  readonly recordId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unit: string;
}

export async function payableSlicerRecords(
  tx: Tx,
  orgId: string,
  input: { storeId: string; from: string; to: string; /** The slicer pay screen also wants the records already paid; a pay run never does. */ includePaid?: boolean },
): Promise<{ records: PayableSlicerRecord[]; lines: SlicerOutputLine[] }> {
  const paidFilter = input.includePaid ? sql`` : sql`and r.paid_by_pay_run_id is null`;
  const records = (await tx.execute(sql`
    select r.id::text as "recordId", r.performed_by_person_id::text as "personId", (select pe.display_name from persons pe where pe.id = r.performed_by_person_id) as "personName",
           r.produced_on::text as "producedOn", r.paid_by_pay_run_id::text as "paidByPayRunId",
           (select e.id::text from employments e
             where e.org_id = r.org_id and e.person_id = r.performed_by_person_id and e.store_id = r.store_id
               and e.started_on <= r.produced_on and (e.ended_on is null or e.ended_on >= r.produced_on)
             order by e.started_on, e.id limit 1) as "employmentId"
      from production_records r
     where r.org_id = ${orgId} and r.store_id = ${input.storeId}
       and r.kind = 'slice' and r.status = 'posted'
       and r.confirmed_at is not null ${paidFilter}
       and r.performed_by_person_id is not null
       -- T-635 S2 (Ian: late confirmations are "paid in the next pay run"): everything confirmed, posted and unpaid up to the period's end, however old. A paid record
       -- is only listed (the screen's paid column) inside the period it belongs to. Attendance days keep their exact window; this does not.
       and r.produced_on <= ${input.to} and (r.paid_by_pay_run_id is null or r.produced_on >= ${input.from})
     order by r.produced_on, r.id
  `)) as unknown as PayableSlicerRecord[];
  if (records.length === 0) return { records, lines: [] };
  const lines = (await tx.execute(sql`
    select l.record_id::text as "recordId", l.item_id::text as "itemId", i.name as "itemName", l.quantity::text as quantity, l.unit
      from production_record_lines l
      join production_records r on r.id = l.record_id and l.revision = r.revision
      join items i on i.id = l.item_id
     where l.record_id in (${sql.join(records.map((x) => sql`${x.recordId}::uuid`), sql`, `)})
       and l.direction = 'in' and l.is_paid and l.reversed_at is null
     order by l.record_id, l.created_at, l.id
  `)) as unknown as SlicerOutputLine[];
  return { records, lines };
}

/** Freezes the records a pay run paid, and returns how many it froze (a record another run already paid is not touched, so the caller can refuse a short count). */
export async function freezeSlicerRecords(tx: Tx, recordIds: readonly string[], runId: string): Promise<number> {
  if (recordIds.length === 0) return 0;
  const rows = await tx
    .update(productionRecords)
    .set({ paidByPayRunId: runId })
    .where(and(inArray(productionRecords.id, [...recordIds]), sql`${productionRecords.paidByPayRunId} is null`))
    .returning({ id: productionRecords.id });
  return rows.length;
}

/** The ONLY place the slicer freeze is lifted: a voided run did not pay, so its records are payable again. */
export async function unfreezeSlicerRecordsOfRun(tx: Tx, runId: string): Promise<number> {
  const rows = await tx
    .update(productionRecords)
    .set({ paidByPayRunId: null })
    .where(eq(productionRecords.paidByPayRunId, runId))
    .returning({ id: productionRecords.id });
  return rows.length;
}

export interface SlicerPayViewRow {
  readonly recordId: string;
  readonly producedOn: string;
  readonly personId: string;
  readonly personName: string;
  readonly confirmedAt: Date | null;
  readonly paidByPayRunId: string | null;
}

/** Every posted slice record of the store in a period that names a slicer, paid or not, for the slicer pay screen. Same inclusive `between` as the pay run. */
export async function slicerRecordsInPeriod(tx: Tx, orgId: string, input: { storeId: string; from: string; to: string }): Promise<SlicerPayViewRow[]> {
  return (await tx.execute(sql`
    select r.id::text as "recordId", r.produced_on::text as "producedOn", r.performed_by_person_id::text as "personId",
           p.display_name as "personName", r.confirmed_at as "confirmedAt", r.paid_by_pay_run_id::text as "paidByPayRunId"
      from production_records r
      join persons p on p.id = r.performed_by_person_id
     where r.org_id = ${orgId} and r.store_id = ${input.storeId}
       and r.kind = 'slice' and r.status = 'posted' and r.performed_by_person_id is not null
       and r.produced_on between ${input.from} and ${input.to}
     order by p.display_name, r.produced_on, r.id
  `)) as unknown as SlicerPayViewRow[];
}

/** True when the person holds the canonical Slicer position at the store today (an open employment). The confirmer must NOT (T-635 S2). */
export async function holdsSlicerNow(tx: Tx, orgId: string, personId: string, storeId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select 1 as one
      from employments e
      join employment_positions ep on ep.employment_id = e.id
      join positions p on p.id = ep.position_id
     where e.org_id = ${orgId} and e.person_id = ${personId} and e.store_id = ${storeId} and e.ended_on is null
       and p.org_id = ${orgId} and p.name = 'Slicer' and p.is_canonical and p.is_active
     limit 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** The people who hold the canonical Slicer position at the store today (open employments), for the "who sliced" picker. */
export async function listSlicersAtStore(tx: Tx, orgId: string, storeId: string): Promise<{ personId: string; personName: string }[]> {
  return (await tx.execute(sql`
    select distinct e.person_id::text as "personId", pe.display_name as "personName"
      from employments e
      join persons pe on pe.id = e.person_id
      join employment_positions ep on ep.employment_id = e.id
      join positions p on p.id = ep.position_id
     where e.org_id = ${orgId} and e.store_id = ${storeId} and e.ended_on is null
       and p.org_id = ${orgId} and p.name = 'Slicer' and p.is_canonical and p.is_active
     order by pe.display_name
  `)) as unknown as { personId: string; personName: string }[];
}

/** Names the slicer of a slice record (an edit of a posted record, after its confirmation was cleared). */
export async function setPerformedBy(tx: Tx, id: string, personId: string | null): Promise<void> {
  await tx.update(productionRecords).set({ performedByPersonId: personId }).where(eq(productionRecords.id, id));
}

/** A draft's paid / unpaid choice: every OUTPUT line of the record is paid when its id is in `paidLineIds`, unpaid otherwise. */
export async function setOutputLinesPaid(tx: Tx, recordId: string, paidLineIds: readonly string[]): Promise<void> {
  const paid = paidLineIds.length > 0 ? sql`${productionRecordLines.id} in (${sql.join(paidLineIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`;
  await tx
    .update(productionRecordLines)
    .set({ isPaid: paid })
    .where(and(eq(productionRecordLines.recordId, recordId), eq(productionRecordLines.direction, 'in'), sql`${productionRecordLines.reversedAt} is null`));
}

/** Display names for a handful of persons (the slicer, the confirmer). */
export async function personNames(tx: Tx, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids)];
  if (want.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select id::text as id, display_name as name from persons
     where org_id = ${orgId} and id in (${sql.join(want.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}
