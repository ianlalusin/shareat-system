/**
 * Reads and form helpers for the recipe screens - T-413. Every rule lives in `packages/domain/src/production/recipes.ts`;
 * this file only reads and shapes what the pages draw.
 */
import { heldCapabilities, type Actor } from '@shareat/auth';
import { itemsRepo, productionRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';

export { withOrgPrincipal };

export const RECIPES_PATH = '/inventory/production/recipes';
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

/** Active items a recipe may use (the pickers); each shows its base unit. */
export async function recipeItemOptions(orgId: string): Promise<RecipeItemOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await itemsRepo.listItems(tx, orgId, { includeInactive: false });
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

export async function recipeList(orgId: string, status: 'active' | 'retired' | 'all'): Promise<RecipeListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const recipes = (await productionRepo.listRecipes(tx, orgId, true)).filter(
      (r) => status === 'all' || (status === 'retired' ? r.status === 'inactive' : r.status === 'active'),
    );
    const items = new Map(
      (await productionRepo.getItemsForProduction(tx, orgId, [...new Set(recipes.map((r) => r.outputItemId))])).map((i) => [i.id, i]),
    );
    const out: RecipeListRow[] = [];
    for (const r of recipes) {
      const lines = await productionRepo.listRecipeLines(tx, r.id);
      const item = items.get(r.outputItemId);
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
  readonly outputItemId: string;
  readonly outputName: string;
  readonly outputUnit: string;
  readonly outputQuantity: string;
  readonly lines: RecipeDetailLine[];
}

export async function recipeDetail(orgId: string, id: string): Promise<RecipeDetail | null> {
  if (!isUuid(id)) return null;
  return withOrgPrincipal(orgId, async (tx) => {
    const r = await productionRepo.getRecipe(tx, orgId, id);
    if (!r) return null;
    const lines = await productionRepo.listRecipeLines(tx, r.id);
    const items = new Map(
      (await productionRepo.getItemsForProduction(tx, orgId, [r.outputItemId, ...lines.map((l) => l.itemId)])).map((i) => [i.id, i]),
    );
    const out = items.get(r.outputItemId);
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      outputItemId: r.outputItemId,
      outputName: out?.name ?? 'its output',
      outputUnit: out?.baseUnit ?? '',
      outputQuantity: r.outputQuantity,
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
