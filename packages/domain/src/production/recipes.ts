/**
 * Production recipes - create, edit, retire, restore. T-413 (docs/tasks/413-production-recipe-admin.md).
 *
 * Admin-only (`manage_recipes`, bible row 315): every function authorizes FIRST, before any read. Rules, in the spec's words:
 *  - R1 quantities are in the item's BASE unit (0 < qty <= 10,000, 3 decimals); the unit written on every line is the item's
 *    `base_unit`. A caller-sent unit that differs is refused, never converted.
 *  - R2 shape guards run before the first write (pure ones in `recipe-shape.ts`).
 *  - R3 an edit is refused while anything unfinished depends on the recipe: a draft cook (E1) or a planned POS usage pull at a
 *    store that uses it (E2). E3 (a posted cook's edit after the recipe moved) lives in `editPostedProduction`.
 *  - R4 retire is refused while an active POS map or a menu rule in force / scheduled names the recipe; restore is refused
 *    while the output or an ingredient is retired. There is no delete: history keeps pointing at the row.
 *  - R5 one audit row per write, appended after the write in the same transaction; a refusal writes none.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, productionRepo, type Tx } from '@shareat/db';
import type { BusinessDate } from '@shareat/core/datetime';
import { money, type Money } from '@shareat/core/money';
import { notActiveItemSentence } from '../items/not-active';
import { parseDecimalInput } from '../shared/money-input';
import { humanDate } from '../shared/refusal-leaf';
import type { Quantity } from '../stock/quantity';
import { validateRecipeShape } from './recipe-shape';

export interface RecipeLineInput {
  readonly itemId: string;
  readonly quantity: string;
  /** Optional: the item's base unit is written. A value that differs from the base unit is refused. */
  readonly unit?: string | undefined;
}

export interface CreateRecipeInput {
  readonly orgId: string;
  readonly name: string;
  /** Required for a product recipe; a kitchen recipe makes no stock item (it is ignored). */
  readonly outputItemId?: string;
  /** T-650 S3: 'product' (default) or 'kitchen' (the cookbook: ingredients + method, no stock output). */
  readonly purpose?: 'product' | 'kitchen';
  /** T-650 S3: the steps, plain text. */
  readonly method?: string;
  /** Product: what one batch makes. Kitchen: how many portions it makes. */
  readonly outputQuantity: string;
  readonly lines: readonly RecipeLineInput[];
  /** T-650 S2: the stores that may make it. Empty / omitted = every store. */
  readonly storeIds?: readonly string[];
  /** T-650 S2: labour for ONE batch (blank / omitted = none). */
  readonly standardLabourCost?: string;
}

export interface EditRecipeInput {
  readonly recipeId: string;
  readonly name: string;
  /** Required for a product recipe, ignored for a kitchen one. A recipe's purpose never changes. */
  readonly outputItemId?: string;
  /** T-650 S3: omit to leave the method as it is; blank clears it. */
  readonly method?: string;
  readonly outputQuantity: string;
  readonly lines: readonly RecipeLineInput[];
  /** T-650 S2: omit to leave the store list as it is; [] removes the limit (every store). */
  readonly storeIds?: readonly string[];
  /** T-650 S2: omit to leave it as it is; blank clears it. */
  readonly standardLabourCost?: string;
}

export type RecipeOutcome = { readonly ok: true; readonly recipeId: string } | { readonly ok: false; readonly reason: string };

const refusal = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const NOT_FOUND = 'That recipe does not exist. Pick a recipe from the list.';

/** The before/after shape the audit rows carry (R5). Read back from the table, so it is what is stored. */
async function snapshot(tx: Tx, orgId: string, recipeId: string) {
  const r = await productionRepo.getRecipe(tx, orgId, recipeId);
  if (!r) return null;
  const lines = await productionRepo.listRecipeLines(tx, recipeId);
  return {
    name: r.name,
    outputItemId: r.outputItemId,
    purpose: r.purpose,
    method: r.method,
    outputQuantity: r.outputQuantity,
    standardLabourCost: r.standardLabourCost,
    storeIds: (await productionRepo.listRecipeStores(tx, orgId, recipeId)).map((s) => s.storeId),
    lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit })),
  };
}

async function audit(tx: Tx, actor: Actor, action: string, recipeId: string, before: unknown, after: unknown): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, { actorPersonId: actor.personId, action, storeId: null, entityId: recipeId, before, after, source: 'web' });
}

type Quantity14_3 = Quantity;

interface Checked {
  readonly name: string;
  readonly outputQuantity: Quantity14_3;
  /** Null for a kitchen recipe. */
  readonly outputItemId: string | null;
  /** undefined = the caller said nothing (edit leaves it); null = cleared. */
  readonly method: string | null | undefined;
  /** undefined = the caller said nothing; null = cleared / none. */
  readonly standardLabourCost: Money | null | undefined;
  readonly storeIds: readonly string[] | undefined;
  readonly lines: { itemId: string; quantity: Quantity14_3; unit: string }[];
}

/** R1 + R2 for create and edit: the pure shape, then the items, the base units, the name. A sentence, or the cleaned input. */
async function checkRecipe(
  tx: Tx,
  orgId: string,
  input: { name: string; outputItemId?: string | undefined; outputQuantity: string; lines: readonly RecipeLineInput[]; storeIds?: readonly string[] | undefined; standardLabourCost?: string | undefined; method?: string | undefined },
  ownId: string | null,
  purpose: 'product' | 'kitchen',
): Promise<{ ok: true; value: Checked } | { ok: false; reason: string }> {
  const kitchen = purpose === 'kitchen';
  const outputItemId = kitchen ? null : (input.outputItemId?.trim() || null);
  const shape = validateRecipeShape({ ...input, outputItemId, purpose });
  if (!shape.ok) return shape;
  const name = input.name.trim();
  // T-650 S3: a cookbook recipe is read by every store and never produced, so it has neither a "Made at" list nor a labour per batch.
  if (kitchen && (input.storeIds ?? []).some((s) => s.trim() !== '')) return refusal('A cookbook recipe is read by every store, so it has no "Made at" list.');
  if (kitchen && (input.standardLabourCost ?? '').trim() !== '') return refusal('A cookbook recipe is not produced, so it has no labour per batch.');

  const items = new Map(
    (await productionRepo.getItemsForProduction(tx, orgId, [...(outputItemId ? [outputItemId] : []), ...input.lines.map((l) => l.itemId)])).map((r) => [r.id, r]),
  );
  if (outputItemId) {
    const out = items.get(outputItemId);
    if (!out) return refusal('The item this recipe makes does not exist. Pick it from the list.');
    if (out.status !== 'active') return refusal(notActiveItemSentence(out.status, 'put on a new recipe', 'The output'));
  }

  const lines: Checked['lines'] = [];
  for (const [i, line] of input.lines.entries()) {
    const item = items.get(line.itemId);
    if (!item) return refusal(`Ingredient ${i + 1} does not exist. Pick it from the list.`);
    if (item.status !== 'active') return refusal(notActiveItemSentence(item.status, 'put on a new recipe', `Ingredient line ${i + 1}`));
    const sent = line.unit?.trim();
    if (sent && sent !== item.baseUnit) {
      return refusal(`Ingredient ${i + 1}: ${item.name} is counted in ${item.baseUnit}, not ${sent}. Enter the quantity in ${item.baseUnit}.`);
    }
    lines.push({
      itemId: line.itemId,
      quantity: parseDecimalInput(line.quantity.trim(), '14,3', `recipe.lines[${i}].quantity`, `Ingredient ${i + 1} quantity`, { blank: 'refuse' }),
      unit: item.baseUnit,
    });
  }

  // T-650 S2: standard labour per batch (>= 0, two decimals) and the stores. A store of another organisation is "not found" here (and refused by the FK underneath).
  let standardLabourCost: Money | null | undefined;
  if (input.standardLabourCost !== undefined) {
    const raw = input.standardLabourCost.trim();
    if (raw === '') standardLabourCost = null;
    else if (raw.startsWith('-')) return refusal('Labour per batch cannot be negative.');
    else standardLabourCost = parseDecimalInput(raw, '14,2', 'recipe.standardLabourCost', 'Labour per batch', { blank: 'refuse' });
  }
  const storeIds = input.storeIds === undefined ? undefined : [...new Set(input.storeIds.map((s) => s.trim()).filter((s) => s !== ''))];
  if (storeIds && storeIds.length > 0) {
    const known = await productionRepo.storeNamesIn(tx, orgId, storeIds);
    const missing = storeIds.find((s) => !known.has(s));
    if (missing) return refusal('One of the stores picked for "Made at" does not exist. Pick the stores from the list.');
  }

  const held = await productionRepo.findRecipeByName(tx, orgId, name);
  if (held && held.id !== ownId) {
    return refusal(
      held.status === 'inactive'
        ? `A retired recipe already has the name '${name}'. Pick another name, or restore that recipe instead.`
        : `A recipe named '${name}' already exists. Pick another name.`,
    );
  }
  return {
    ok: true,
    value: {
      name,
      outputQuantity: parseDecimalInput(input.outputQuantity.trim(), '14,3', 'recipe.outputQuantity', 'The output quantity', { blank: 'refuse' }),
      standardLabourCost,
      storeIds,
      outputItemId,
      method: input.method === undefined ? undefined : input.method.trim() === '' ? null : input.method.trim(),
      lines,
    },
  };
}

const andMore = (n: number): string => (n > 0 ? ` (and ${n} more)` : '');

export async function createRecipe(tx: Tx, actor: Actor, input: CreateRecipeInput): Promise<RecipeOutcome> {
  await authorize(tx, actor, 'manage_recipes', {}); // T-403: admin-only
  const purpose = input.purpose ?? 'product';
  const checked = await checkRecipe(tx, input.orgId, input, null, purpose);
  if (!checked.ok) return checked;
  const { id: recipeId } = await productionRepo.insertRecipe(tx, {
    orgId: input.orgId,
    name: checked.value.name,
    outputItemId: checked.value.outputItemId,
    purpose,
    method: checked.value.method ?? null,
    outputQuantity: checked.value.outputQuantity,
    standardLabourCost: checked.value.standardLabourCost ?? null,
    createdBy: actor.personId,
  });
  await productionRepo.insertRecipeLines(tx, recipeId, checked.value.lines);
  if (checked.value.storeIds && checked.value.storeIds.length > 0) await productionRepo.replaceRecipeStores(tx, input.orgId, recipeId, checked.value.storeIds);
  await audit(tx, actor, 'production.recipe_create', recipeId, null, await snapshot(tx, input.orgId, recipeId));
  return { ok: true, recipeId };
}

export async function editRecipe(tx: Tx, actor: Actor, input: EditRecipeInput): Promise<RecipeOutcome> {
  await authorize(tx, actor, 'manage_recipes', {});
  const existing = await productionRepo.getRecipe(tx, actor.orgId, input.recipeId);
  if (!existing) return refusal(NOT_FOUND);
  const checked = await checkRecipe(tx, actor.orgId, input, existing.id, existing.purpose);
  if (!checked.ok) return checked;

  // E1: an unfinished cook was worked out from the current ratios.
  const drafts = await productionRepo.listDraftRecordsUsingRecipe(tx, actor.orgId, existing.id);
  const draft = drafts[0];
  if (draft) {
    return refusal(
      `Post or void the cook drafted at ${draft.storeName} on ${humanDate(draft.producedOn as BusinessDate)}${andMore(drafts.length - 1)} first: it was worked out from this recipe.`,
    );
  }
  // E2: a planned usage pull at a store that uses this recipe would change under its manager.
  const pulls = await productionRepo.listPlannedPullsUsingRecipe(tx, actor.orgId, existing.id);
  const pull = pulls[0];
  if (pull) {
    return refusal(
      `Finish or void the ${humanDate(pull.businessDate as BusinessDate)} usage pull at ${pull.storeName}${andMore(pulls.length - 1)} first: this recipe decides what that pull takes out of stock, and changing it now would change a pull that is not finished.`,
    );
  }

  const before = await snapshot(tx, actor.orgId, existing.id);
  await productionRepo.updateRecipe(tx, actor.orgId, existing.id, {
    name: checked.value.name,
    outputItemId: checked.value.outputItemId,
    ...(checked.value.method === undefined ? {} : { method: checked.value.method }),
    outputQuantity: checked.value.outputQuantity,
    standardLabourCost: checked.value.standardLabourCost === undefined ? (existing.standardLabourCost === null ? null : money(existing.standardLabourCost)) : checked.value.standardLabourCost,
  });
  if (checked.value.storeIds !== undefined) await productionRepo.replaceRecipeStores(tx, actor.orgId, existing.id, checked.value.storeIds);
  await productionRepo.replaceRecipeLines(tx, actor.orgId, existing.id, checked.value.lines);
  await audit(tx, actor, 'production.recipe_edit', existing.id, before, await snapshot(tx, actor.orgId, existing.id));
  return { ok: true, recipeId: existing.id };
}

export async function retireRecipe(tx: Tx, actor: Actor, input: { recipeId: string }): Promise<RecipeOutcome> {
  await authorize(tx, actor, 'manage_recipes', {});
  const existing = await productionRepo.getRecipe(tx, actor.orgId, input.recipeId);
  if (!existing) return refusal(NOT_FOUND);
  if (existing.status !== 'active') return refusal(`The recipe '${existing.name}' is already retired.`);
  // An open draft does not block: a draft loads its recipe in any status, so it still posts.
  const users = await productionRepo.listRecipeDependents(tx, actor.orgId, existing.id);
  const first = users[0];
  if (first) {
    const one = users.length === 1;
    return refusal(
      `Re-map ${first.kind === 'map' ? 'the POS item' : 'the menu item'} '${first.name}'${andMore(users.length - 1)} first: ${one ? 'it uses' : 'they use'} the recipe '${existing.name}', and the daily usage would skip ${one ? 'it' : 'them'} once the recipe is retired.`,
    );
  }
  const shape = await snapshot(tx, actor.orgId, existing.id);
  await productionRepo.setRecipeStatus(tx, actor.orgId, existing.id, 'inactive');
  await audit(tx, actor, 'production.recipe_retire', existing.id, shape, shape);
  return { ok: true, recipeId: existing.id };
}

export async function restoreRecipe(tx: Tx, actor: Actor, input: { recipeId: string }): Promise<RecipeOutcome> {
  await authorize(tx, actor, 'manage_recipes', {});
  const existing = await productionRepo.getRecipe(tx, actor.orgId, input.recipeId);
  if (!existing) return refusal(NOT_FOUND);
  if (existing.status === 'active') return refusal(`The recipe '${existing.name}' is already active.`);
  const lines = await productionRepo.listRecipeLines(tx, existing.id);
  const items = await productionRepo.getItemsForProduction(tx, actor.orgId, [...(existing.outputItemId ? [existing.outputItemId] : []), ...lines.map((l) => l.itemId)]);
  const retired = (id: string) => items.find((i) => i.id === id && i.status !== 'active');
  const out = existing.outputItemId ? retired(existing.outputItemId) : undefined;
  if (out) return refusal(notActiveItemSentence(out.status, 'put back on a recipe', `The output (${out.name})`));
  for (const l of lines) {
    const bad = retired(l.itemId);
    if (bad) return refusal(notActiveItemSentence(bad.status, 'put back on a recipe', `The ingredient ${bad.name}`));
  }
  const shape = await snapshot(tx, actor.orgId, existing.id);
  await productionRepo.setRecipeStatus(tx, actor.orgId, existing.id, 'active');
  await audit(tx, actor, 'production.recipe_restore', existing.id, shape, shape);
  return { ok: true, recipeId: existing.id };
}
