/**
 * The pure explosion and diff for the daily POS usage pull — T-177.
 *
 * ⭐ No Firestore, no Postgres, no `fetch` — a POS snapshot and the store's own mapping/recipe
 * data go in, a flat list of plan lines comes out. `usage-pull.ts` is the impure orchestrator that
 * fetches the inputs (live from POS, from the repo) and calls this twice: once at plan time, once
 * again at finalize time for invariant 2's rebuild-and-diff.
 *
 * ## The three sections (§7 of the task doc — v2's OWN vocabulary, not v1's)
 *
 * `direct` — a POS item mapped 1:1 to a stock item. `recipe` — a POS item mapped to a production
 * recipe, exploded to one line per ingredient. `orphan` — a POS item with NO active map at all.
 * ⛔ **Not v1's meaning.** v1's `orphan` was "a stale prior pull record with no live demand" — this
 * project's simplified model has no cross-pull revision state (invariant 12: a second pull for the
 * same day is refused while one is live), so that concept does not exist here. Follow this task
 * doc's own definitions, not v1's.
 *
 * A `no_stock` map produces NO line at all (invariant 6) — it consumes nothing and must not
 * resurface as an orphan every day.
 *
 * ## Physical quantity (invariant 1)
 *
 * `posItems[].physicalQty` is trusted AS GIVEN — POS's own `api/external/sold-items` already nets
 * sold + comped − voided server-side (`POS/src/lib/analytics/sold-items-core.ts`), so this module
 * never recomputes it and never reaches for a billable figure.
 *
 * ## Recipe explosion — per-LINE blocking, not v1's all-or-nothing (test 2)
 *
 * v1 blocks an entire dish when any one ingredient's unit fails to convert ("all-or-nothing... a
 * half-recorded dish is worse than none"). This task's own test 2 states the opposite explicitly:
 * *"an unconvertible unit blocks that line and not the pull."* Followed here as written — each
 * ingredient line stands or falls on its own.
 */
import { decimal, type Decimal } from '@shareat/core/money';
import {
  compareQuantity,
  fromThousandths,
  quantity,
  toThousandths,
  ZERO_QUANTITY,
  type Quantity,
} from '../stock/quantity';
import { convertUnit, divideRoundHalfUp } from '../production/unit-conversion';

export type PosMapMode = 'direct' | 'recipe' | 'no_stock';
export type PlanSection = 'direct' | 'recipe' | 'orphan';

export interface PosSoldItemInput {
  readonly posItemKey: string;
  readonly posItemName: string;
  /** Decimal string. Already physical (sold + comped − voided) — see this file's header. */
  readonly physicalQty: string;
}

export interface MapLookup {
  readonly mode: PosMapMode;
  readonly itemId: string | null;
  readonly recipeId: string | null;
  /** Decimal string, numeric(14,6). Required for 'direct'. */
  readonly quantityPerSale: string | null;
  /** Per-item override. Null = use the pull's own `defaultLocationId`. */
  readonly locationId: string | null;
}

export interface RecipeIngredientLookup {
  readonly itemId: string;
  /** As written on the recipe line, before scaling. */
  readonly quantity: string;
  readonly unit: string;
  /** The ingredient ITEM's own base unit — what `convertUnit` converts INTO. */
  readonly itemBaseUnit: string;
}

export interface RecipeLookup {
  readonly outputQuantity: string;
  readonly lines: readonly RecipeIngredientLookup[];
}

export interface PlanLine {
  /** Deterministic identity a client confirms against (invariant 2). Stable across a plan/finalize
   *  pair as long as the underlying mapping shape (which items, how many recipe lines) is
   *  unchanged — a quantity or POS-name change does NOT change the key. */
  readonly key: string;
  readonly section: PlanSection;
  readonly posItemKey: string;
  readonly posItemName: string;
  /** Null for an orphan line, or a recipe line whose recipe itself could not be resolved at all. */
  readonly itemId: string | null;
  /** Null wherever `itemId` is null, or a recipe/direct line that is blocked. */
  readonly locationId: string | null;
  /** Null for orphan, and for any blocked line. */
  readonly quantity: Quantity | null;
  readonly blocked: boolean;
  readonly blockReason: string | null;
}

export interface ExplodeInput {
  readonly posItems: readonly PosSoldItemInput[];
  readonly mapsByPosItemKey: ReadonlyMap<string, MapLookup>;
  readonly recipesById: ReadonlyMap<string, RecipeLookup>;
  /** The pull's own chosen operating location — the fallback every map without its own override
   *  resolves to. */
  readonly defaultLocationId: string;
}

/** `qty * rate`, where `rate` is a plain decimal string (numeric(14,6), e.g. "quantity_per_sale").
 *  Computed in integer thousandths x millionths, rounded half-up once at the end — the same
 *  "round once, at the end" discipline `production/index.ts`'s `divideMoneyByQty` uses. Not a
 *  duplicate of that function: this scales a QUANTITY by a dimensionless RATE, not a Money by a
 *  Quantity. */
function scaleByRate(qty: Quantity, rate: Decimal<'14,6'>): Quantity {
  const q = toThousandths(qty); // x1e3
  const [whole, frac = ''] = rate.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const rateMicros = BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0'); // x1e6
  const scaled = q * rateMicros; // x1e9
  const rounded = (scaled + 500_000n) / 1_000_000n; // back to x1e3, half-up
  return fromThousandths(rounded);
}

/** A plain unsigned decimal string, minted as a `Quantity` when it is greater than zero; anything
 *  else (blank, signed, malformed, zero) is `ZERO_QUANTITY`. T-371 — the positivity test is an exact
 *  `compareQuantity`, never `Number(s) > 0` (NaN-blind). More than three places still throws in
 *  `quantity()`, exactly as before. */
function positiveQuantityOrZero(s: string): Quantity {
  if (!/^\d+(\.\d+)?$/.test(s.trim())) return ZERO_QUANTITY;
  const q = quantity(s);
  return compareQuantity(q, ZERO_QUANTITY) > 0 ? q : ZERO_QUANTITY;
}

/**
 * Ingredient scale = physicalQty / recipeOutputQuantity, applied to the ingredient's OWN written
 * quantity, in the ingredient LINE's own unit.
 *
 * ⚠️ **Deliberately NOT `production/index.ts`'s `scaleQuantity`**, and not merely because that
 * file is off this module's dependency graph (plan.ts is pure; that file authorizes and posts).
 * `production/index.ts`'s `scaleQuantity` was fixed by T-339 (DEF-165). The two are now
 * behaviourally identical; they stay separate only for the purity reason stated above, not
 * because either is broken. Both now round through `unit-conversion.ts`'s `divideRoundHalfUp` —
 * one rounding rule, two callers.
 */
function scaleIngredient(lineQty: Quantity, physicalQty: Quantity, outputQty: Quantity): Quantity {
  const v = toThousandths(lineQty);
  const n = toThousandths(physicalQty);
  const d = toThousandths(outputQty);
  if (d === 0n) return ZERO_QUANTITY;
  return fromThousandths(divideRoundHalfUp(v * n, d));
}

export function explodePosSales(input: ExplodeInput): PlanLine[] {
  const lines: PlanLine[] = [];

  for (const item of input.posItems) {
    const map = input.mapsByPosItemKey.get(item.posItemKey);

    // No active map at all -> orphan (invariant 7). ⛔ A `no_stock` map produces NOTHING (invariant
    // 6) — it must not appear here, so it falls through to neither branch below.
    if (!map) {
      lines.push({
        key: `orphan:${item.posItemKey}`,
        section: 'orphan',
        posItemKey: item.posItemKey,
        posItemName: item.posItemName,
        itemId: null,
        locationId: null,
        quantity: null,
        blocked: false,
        blockReason: null,
      });
      continue;
    }

    if (map.mode === 'no_stock') continue;

    const resolvedLocationId = map.locationId ?? input.defaultLocationId;
    const physicalQty = positiveQuantityOrZero(item.physicalQty);

    if (map.mode === 'direct') {
      // R4 — the stored numeric(14,6) rate is re-minted into its brand, never trusted as a bare string.
      const rate = decimal(map.quantityPerSale ?? '1', '14,6');
      const qty = scaleByRate(physicalQty, rate);
      lines.push({
        key: `direct:${item.posItemKey}`,
        section: 'direct',
        posItemKey: item.posItemKey,
        posItemName: item.posItemName,
        itemId: map.itemId,
        locationId: resolvedLocationId,
        quantity: compareQuantity(qty, ZERO_QUANTITY) > 0 ? qty : null,
        blocked: false,
        blockReason: null,
      });
      continue;
    }

    // mode === 'recipe'
    const recipe = map.recipeId ? input.recipesById.get(map.recipeId) : undefined;
    if (!recipe) {
      lines.push({
        key: `recipe:${item.posItemKey}:missing`,
        section: 'recipe',
        posItemKey: item.posItemKey,
        posItemName: item.posItemName,
        itemId: null,
        locationId: resolvedLocationId,
        quantity: null,
        blocked: true,
        blockReason: `the recipe mapped to "${item.posItemName}" no longer exists or is inactive`,
      });
      continue;
    }
    const outputQty = positiveQuantityOrZero(recipe.outputQuantity);
    if (compareQuantity(outputQty, ZERO_QUANTITY) <= 0) {
      lines.push({
        key: `recipe:${item.posItemKey}:invalid-yield`,
        section: 'recipe',
        posItemKey: item.posItemKey,
        posItemName: item.posItemName,
        itemId: null,
        locationId: resolvedLocationId,
        quantity: null,
        blocked: true,
        blockReason: `recipe mapped to "${item.posItemName}" has no output quantity to scale against`,
      });
      continue;
    }
    if (recipe.lines.length === 0) {
      lines.push({
        key: `recipe:${item.posItemKey}:empty`,
        section: 'recipe',
        posItemKey: item.posItemKey,
        posItemName: item.posItemName,
        itemId: null,
        locationId: resolvedLocationId,
        quantity: null,
        blocked: true,
        blockReason: `recipe mapped to "${item.posItemName}" has no ingredient lines`,
      });
      continue;
    }

    if (compareQuantity(physicalQty, ZERO_QUANTITY) <= 0) continue; // nothing sold -> nothing to explode

    recipe.lines.forEach((ingredient, index) => {
      const lineQty = positiveQuantityOrZero(ingredient.quantity);
      const scaledInLineUnit = scaleIngredient(lineQty, physicalQty, outputQty);
      const converted = convertUnit(scaledInLineUnit, ingredient.unit, ingredient.itemBaseUnit);

      if (converted === null) {
        lines.push({
          key: `recipe:${item.posItemKey}:${index}`,
          section: 'recipe',
          posItemKey: item.posItemKey,
          posItemName: item.posItemName,
          itemId: ingredient.itemId,
          locationId: resolvedLocationId,
          quantity: null,
          blocked: true,
          blockReason:
            `recipe line for item ${ingredient.itemId} is in "${ingredient.unit}", which cannot be ` +
            `converted to its base unit "${ingredient.itemBaseUnit}"`,
        });
        return;
      }

      lines.push({
        key: `recipe:${item.posItemKey}:${index}`,
        section: 'recipe',
        posItemKey: item.posItemKey,
        posItemName: item.posItemName,
        itemId: ingredient.itemId,
        locationId: resolvedLocationId,
        quantity: compareQuantity(converted, ZERO_QUANTITY) > 0 ? converted : null,
        blocked: false,
        blockReason: null,
      });
    });
  }

  return lines;
}
