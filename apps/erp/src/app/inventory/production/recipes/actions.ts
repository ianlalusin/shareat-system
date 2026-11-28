'use server';

/**
 * Server actions for the recipe screens - T-413. Thin adapters: read the form, call the domain
 * (`createRecipe` / `editRecipe` / `retireRecipe` / `restoreRecipe`, which authorize `manage_recipes` and hold every rule),
 * redirect with a banner. The actor comes from the session. The form sends NO unit: the domain writes each item's base
 * unit, and any `lineUnit` / `unit` a hostile client sends is never read.
 */
import { assertFieldRules, createRecipe, editRecipe, restoreRecipe, retireRecipe, type RecipeOutcome } from '@shareat/domain';
import { can } from '@shareat/auth';
import { INVENTORY_RECIPE_RULES } from '@shareat/domain/field-rules';
import type { Tx } from '@shareat/db';
import { requireActor } from '../../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { errorMessage } from '@/lib/constraint-messages';
import { loadDestructiveTarget, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { RECIPES_PATH, isUuid, recipeBase, withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** The ingredient rows, in order; a row with neither an item nor a quantity is an empty row and is dropped. */
function lines(fd: FormData): { itemId: string; quantity: string }[] {
  const ids = fd.getAll('lineItemId').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const qs = fd.getAll('lineQuantity').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const rows: { itemId: string; quantity: string }[] = [];
  const n = Math.max(ids.length, qs.length);
  for (let i = 0; i < n; i += 1) {
    const itemId = ids[i] ?? '';
    const quantity = qs[i] ?? '';
    if (itemId === '' && quantity === '') continue;
    rows.push({ itemId, quantity });
  }
  return rows;
}

/** T-650 S2: the "Made at" boxes that were ticked (none ticked = every store) and the labour-per-batch box (blank = none). */
function madeAt(fd: FormData): { storeIds: string[]; standardLabourCost: string } {
  return { storeIds: fd.getAll('storeId').filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()), standardLabourCost: str(fd, 'standardLabourCost') };
}

async function attempt(orgId: string, run: (tx: Tx) => Promise<RecipeOutcome>): Promise<{ ok: true; recipeId: string } | { ok: false; error: string }> {
  try {
    const r = await withOrgPrincipal(orgId, run);
    return r.ok ? r : { ok: false, error: r.reason };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** T-650 S3: the cookbook's forms send purpose=kitchen; everything else is a product recipe. */
const purposeOf = (fd: FormData): 'product' | 'kitchen' => (str(fd, 'purpose') === 'kitchen' ? 'kitchen' : 'product');

/** Where a write on an existing recipe lands: its own page when the id is an id, else the list. */
const detailPath = (recipeId: string, purpose: 'product' | 'kitchen' = 'product'): string => (isUuid(recipeId) ? `${recipeBase(purpose)}/${recipeId}` : recipeBase(purpose));

export async function createRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const r = await attempt(actor.orgId, async (tx) => {
    // T-440 S9 (iii): the field check runs only for a caller createRecipe's own authorize() would let in.
    if (await can(tx, actor, 'manage_recipes', {})) assertFieldRules(INVENTORY_RECIPE_RULES, fd);
    const purpose = purposeOf(fd);
    return createRecipe(tx, actor, {
      orgId: actor.orgId, name: str(fd, 'name'), outputItemId: str(fd, 'outputItemId'), outputQuantity: str(fd, 'outputQuantity'), lines: lines(fd), purpose,
      ...(purpose === 'kitchen' ? { method: str(fd, 'method') } : madeAt(fd)),
    });
  });
  if (!r.ok) return await redirectWithFlash(`${recipeBase(purposeOf(fd))}/new`, {}, { error: r.error });
  return await redirectWithFlash(detailPath(r.recipeId, purposeOf(fd)), {}, { ok: 'Recipe added.' });
}

export async function editRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const recipeId = str(fd, 'recipeId');
  const r = await attempt(actor.orgId, async (tx) => {
    if (await can(tx, actor, 'manage_recipes', {})) assertFieldRules(INVENTORY_RECIPE_RULES, fd);
    const purpose = purposeOf(fd);
    return editRecipe(tx, actor, {
      recipeId, name: str(fd, 'name'), outputItemId: str(fd, 'outputItemId'), outputQuantity: str(fd, 'outputQuantity'), lines: lines(fd),
      ...(purpose === 'kitchen' ? { method: str(fd, 'method') } : madeAt(fd)),
    });
  });
  return await redirectWithFlash(detailPath(recipeId, purposeOf(fd)), {}, r.ok ? { ok: 'Recipe saved.' } : { error: r.error });
}

export async function retireRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const recipeId = str(fd, 'recipeId');
  try {
    // T-412 Tier R: the person retypes the recipe's name; the server compares it with the name IT loads.
    const target = await loadDestructiveTarget(actor, 'production_recipe', recipeId, ['manage_recipes']);
    if (!retypeMatches(str(fd, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
  } catch (err) {
    return await redirectWithFlash(detailPath(recipeId, purposeOf(fd)), {}, { error: errorMessage(err) });
  }
  const r = await attempt(actor.orgId, (tx) => retireRecipe(tx, actor, { recipeId }));
  return await redirectWithFlash(detailPath(recipeId, purposeOf(fd)), {}, r.ok ? { ok: 'Recipe retired.' } : { error: r.error });
}

export async function restoreRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const recipeId = str(fd, 'recipeId');
  const r = await attempt(actor.orgId, (tx) => restoreRecipe(tx, actor, { recipeId }));
  return await redirectWithFlash(detailPath(recipeId, purposeOf(fd)), {}, r.ok ? { ok: 'Recipe restored.' } : { error: r.error });
}
