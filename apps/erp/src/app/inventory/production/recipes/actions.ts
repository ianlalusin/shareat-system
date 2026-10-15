'use server';

/**
 * Server actions for the recipe screens - T-413. Thin adapters: read the form, call the domain
 * (`createRecipe` / `editRecipe` / `retireRecipe` / `restoreRecipe`, which authorize `manage_recipes` and hold every rule),
 * redirect with a banner. The actor comes from the session. The form sends NO unit: the domain writes each item's base
 * unit, and any `lineUnit` / `unit` a hostile client sends is never read.
 */
import { createRecipe, editRecipe, restoreRecipe, retireRecipe, type RecipeOutcome } from '@shareat/domain';
import type { Tx } from '@shareat/db';
import { requireActor } from '../../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { errorMessage } from '@/lib/constraint-messages';
import { loadDestructiveTarget, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { RECIPES_PATH, isUuid, withOrgPrincipal } from './lib';

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

async function attempt(orgId: string, run: (tx: Tx) => Promise<RecipeOutcome>): Promise<{ ok: true; recipeId: string } | { ok: false; error: string }> {
  try {
    const r = await withOrgPrincipal(orgId, run);
    return r.ok ? r : { ok: false, error: r.reason };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Where a write on an existing recipe lands: its own page when the id is an id, else the list. */
const detailPath = (recipeId: string): string => (isUuid(recipeId) ? `${RECIPES_PATH}/${recipeId}` : RECIPES_PATH);

export async function createRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const r = await attempt(actor.orgId, (tx) =>
    createRecipe(tx, actor, { orgId: actor.orgId, name: str(fd, 'name'), outputItemId: str(fd, 'outputItemId'), outputQuantity: str(fd, 'outputQuantity'), lines: lines(fd) }),
  );
  if (!r.ok) return await redirectWithFlash(`${RECIPES_PATH}/new`, {}, { error: r.error });
  return await redirectWithFlash(detailPath(r.recipeId), {}, { ok: 'Recipe added.' });
}

export async function editRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const recipeId = str(fd, 'recipeId');
  const r = await attempt(actor.orgId, (tx) =>
    editRecipe(tx, actor, { recipeId, name: str(fd, 'name'), outputItemId: str(fd, 'outputItemId'), outputQuantity: str(fd, 'outputQuantity'), lines: lines(fd) }),
  );
  return await redirectWithFlash(detailPath(recipeId), {}, r.ok ? { ok: 'Recipe saved.' } : { error: r.error });
}

export async function retireRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const recipeId = str(fd, 'recipeId');
  try {
    // T-412 Tier R: the person retypes the recipe's name; the server compares it with the name IT loads.
    const target = await loadDestructiveTarget(actor, 'production_recipe', recipeId, ['manage_recipes']);
    if (!retypeMatches(str(fd, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
  } catch (err) {
    return await redirectWithFlash(detailPath(recipeId), {}, { error: errorMessage(err) });
  }
  const r = await attempt(actor.orgId, (tx) => retireRecipe(tx, actor, { recipeId }));
  return await redirectWithFlash(detailPath(recipeId), {}, r.ok ? { ok: 'Recipe retired.' } : { error: r.error });
}

export async function restoreRecipeAction(fd: FormData): Promise<void> {
  const actor = await requireActor(RECIPES_PATH);
  const recipeId = str(fd, 'recipeId');
  const r = await attempt(actor.orgId, (tx) => restoreRecipe(tx, actor, { recipeId }));
  return await redirectWithFlash(detailPath(recipeId), {}, r.ok ? { ok: 'Recipe restored.' } : { error: r.error });
}
