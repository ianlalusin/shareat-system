/**
 * Reads and form helpers for the recipe screens - T-413. Every rule lives in `packages/domain/src/production/recipes.ts`;
 * this file only reads and shapes what the pages draw.
 */
import { heldCapabilities, type Actor } from '@shareat/auth';
import { itemsRepo, productionRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';

export { withOrgPrincipal };

export const RECIPES_PATH = '/inventory/production/recipes';
/** T-650 S3: the cookbook (kitchen recipes: ingredients + method, no stock output). RECIPES_PATH is "Products we make". */
export const COOKBOOK_PATH = '/inventory/cookbook';
export type RecipePurpose = 'product' | 'kitchen';
export const recipeBase = (purpose: RecipePurpose): string => (purpose === 'kitchen' ? COOKBOOK_PATH : RECIPES_PATH);
export const MANAGE_RECIPES = 'manage_recipes';

export interface RecipeItemOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly baseUnit: string;
}

/** 2.000 -> "2", 1.500 -> "1.5", 10 -> "10". */
export function fmtQty(q: string): string {
  return q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q;
}

export const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function canManageRecipes(orgId: string, actor: Actor): Promise<boolean> {
  return withOrgPrincipal(orgId, async (tx) => (await heldCapabilities(tx, actor)).has(MANAGE_RECIPES));
}

/**
 * T-583 S2: which cookbook shortcut the Cook tab shows. `post_production` holders (manager, admin, super) get "Cookbook settings";
 * a cook who may only record a run (`record_stock_movement`, held by position) gets a plain read "Recipes" link; anyone else, none.
 * `heldCapabilities` reads role and grants (position grants are person_grants rows) but not store scope: fine for presentation,
 * the page read gate uses the same set and every action authorizes again.
 */
export async function cookbookShortcut(orgId: string, actor: Actor): Promise<'settings' | 'read' | null> {
  const held = await withOrgPrincipal(orgId, async (tx) => heldCapabilities(tx, actor));
  return held.has('post_production') ? 'settings' : held.has('record_stock_movement') ? 'read' : null;
}

/** Active items a recipe may use (the pickers); each shows its base unit. */
export async function recipeItemOptions(orgId: string): Promise<RecipeItemOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await itemsRepo.listItems(tx, orgId, { includeInactive: false, stockedOnly: true });
    return rows.map((i) => ({ id: i.id, code: i.code, name: i.name, baseUnit: i.baseUnit }));
  });
}

export interface RecipeListRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly outputQuantity: string;
  readonly outputName: string;
  readonly outputUnit: string;
  readonly ingredientCount: number;
}

export async function recipeList(orgId: string, status: 'active' | 'retired' | 'all', purpose: RecipePurpose = 'product'): Promise<RecipeListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const recipes = (await productionRepo.listRecipes(tx, orgId, true, purpose)).filter(
      (r) => status === 'all' || (status === 'retired' ? r.status === 'inactive' : r.status === 'active'),
    );
    const items = new Map(
      (await productionRepo.getItemsForProduction(tx, orgId, [...new Set(recipes.flatMap((r) => (r.outputItemId ? [r.outputItemId] : [])))])).map((i) => [i.id, i]),
    );
    const out: RecipeListRow[] = [];
    for (const r of recipes) {
      const lines = await productionRepo.listRecipeLines(tx, r.id);
      const item = r.outputItemId ? items.get(r.outputItemId) : undefined;
      out.push({
        id: r.id,
        name: r.name,
        status: r.status,
        outputQuantity: r.outputQuantity,
        outputName: item?.name ?? 'its output',
        outputUnit: item?.baseUnit ?? '',
        ingredientCount: lines.length,
      });
    }
    return out;
  });
}

export interface RecipeDetailLine {
  readonly itemId: string;
  readonly itemName: string;
  readonly baseUnit: string;
  /** The stored quantity and unit, as written. */
  readonly quantity: string;
  readonly unit: string;
}

export interface RecipeDetail {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** Null for a cookbook recipe. */
  readonly outputItemId: string | null;
  readonly purpose: RecipePurpose;
  /** T-650 S3: the steps of a cookbook recipe. */
  readonly method: string | null;
  readonly outputName: string;
  readonly outputUnit: string;
  readonly outputQuantity: string;
  /** T-650 S2: labour for one batch, or null. */
  readonly standardLabourCost: string | null;
  /** T-650 S2: the stores it is limited to (empty = every store). */
  readonly storeIds: string[];
  readonly lines: RecipeDetailLine[];
}

export async function recipeDetail(orgId: string, id: string): Promise<RecipeDetail | null> {
  if (!isUuid(id)) return null;
  return withOrgPrincipal(orgId, async (tx) => {
    const r = await productionRepo.getRecipe(tx, orgId, id);
    if (!r) return null;
    const lines = await productionRepo.listRecipeLines(tx, r.id);
    const items = new Map(
      (await productionRepo.getItemsForProduction(tx, orgId, [...(r.outputItemId ? [r.outputItemId] : []), ...lines.map((l) => l.itemId)])).map((i) => [i.id, i]),
    );
    const out = r.outputItemId ? items.get(r.outputItemId) : undefined;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      outputItemId: r.outputItemId,
      purpose: r.purpose,
      method: r.method,
      outputName: out?.name ?? 'its output',
      outputUnit: out?.baseUnit ?? '',
      outputQuantity: r.outputQuantity,
      standardLabourCost: r.standardLabourCost,
      storeIds: (await productionRepo.listRecipeStores(tx, orgId, r.id)).map((s) => s.storeId),
      lines: lines.map((l) => ({
        itemId: l.itemId,
        itemName: items.get(l.itemId)?.name ?? 'an item',
        baseUnit: items.get(l.itemId)?.baseUnit ?? l.unit,
        quantity: l.quantity,
        unit: l.unit,
      })),
    };
  });
}
