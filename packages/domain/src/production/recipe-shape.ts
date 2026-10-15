/**
 * T-413 R1/R2 - the part of a recipe's shape that needs no database: the figures, the name, the line count, duplicates and
 * the output used as its own ingredient. Pure, so the unit tests run without Postgres. What needs the database (the items'
 * existence, status, org and base unit, the name's uniqueness) stays in `recipes.ts`.
 *
 * Quantities are text. 0 < qty <= 10,000, at most 3 decimals (the column is numeric(14,3)), in the item's BASE unit.
 */
export const MAX_RECIPE_QUANTITY_THOUSANDTHS = 10_000_000n;
export const MAX_RECIPE_NAME_LENGTH = 80;
export const MAX_RECIPE_LINES = 50;

export interface RecipeShapeInput {
  readonly name: string;
  readonly outputItemId: string;
  readonly outputQuantity: string;
  readonly lines: readonly { readonly itemId: string; readonly quantity: string }[];
}

export type RecipeShapeOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The quantity in thousandths, or null when it is not a plain number with at most three decimals. */
function thousandths(raw: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
}

/** The sentence for a bad figure, or null when it is fine. `what` is e.g. "The output quantity". */
export function recipeQuantityRefusal(raw: string, what: string): string | null {
  const t = thousandths(raw);
  if (t === null) return `${what} must be a number greater than zero, with at most 3 decimal places.`;
  if (t <= 0n) return `${what} must be greater than zero.`;
  if (t > MAX_RECIPE_QUANTITY_THOUSANDTHS) return `${what} cannot be more than 10,000 in the item's base unit. Check the figure.`;
  return null;
}

export function validateRecipeShape(input: RecipeShapeInput): RecipeShapeOutcome {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: 'A recipe needs a name.' };
  if (name.length > MAX_RECIPE_NAME_LENGTH) return { ok: false, reason: `A recipe name can be at most ${MAX_RECIPE_NAME_LENGTH} characters. This one is ${name.length}.` };

  const out = recipeQuantityRefusal(input.outputQuantity, 'The output quantity');
  if (out) return { ok: false, reason: out };

  if (input.lines.length === 0) return { ok: false, reason: 'A recipe needs at least one ingredient.' };
  if (input.lines.length > MAX_RECIPE_LINES) return { ok: false, reason: `A recipe can have at most ${MAX_RECIPE_LINES} ingredients. This one has ${input.lines.length}.` };

  const seen = new Set<string>();
  for (const [i, line] of input.lines.entries()) {
    const bad = recipeQuantityRefusal(line.quantity, `Ingredient ${i + 1}'s quantity`);
    if (bad) return { ok: false, reason: bad };
    if (line.itemId === input.outputItemId) return { ok: false, reason: 'The item the recipe makes cannot also be one of its ingredients.' };
    if (seen.has(line.itemId)) return { ok: false, reason: 'An ingredient is listed twice. Put each ingredient on one line.' };
    seen.add(line.itemId);
  }
  return { ok: true };
}
