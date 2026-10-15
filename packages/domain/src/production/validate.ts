/**
 * Production validation — T-176 §4, §8, §10.1-§10.5. Pure: no database, testable on its own —
 * the same split `stock/layers.ts` and `stock/transfer-rules.ts` already use.
 *
 * ⭐ **Two tiers, and the two-tier design itself is the pattern kept from v1 (§4):**
 * HARD blocks refuse the post outright; SOFT warnings are stamped on the record and let through.
 * A SOFT warning promoted to a HARD block without a decision is a defect, not a tightening.
 */
import { add, compare, fromCentavos, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';
import {
  addQuantity,
  compareQuantity,
  isPositiveQuantity,
  quantity,
  subtractQuantity,
  toThousandths,
  ZERO_QUANTITY,
  type Quantity,
} from '../stock/quantity';
import { convertUnit } from './unit-conversion';

/**
 * ⚠️ §10.2 / §16.6. A SCALE tolerance — two weighings of the same meat legitimately differ by
 * grams — NOT the `1e-6` float defence T-161 deleted (that one could never fire against exact
 * `numeric(14,3)` decimals; this one fires constantly and should). Used in exactly two places:
 * stock sufficiency and output-exceeds-input. ⛔ Do not delete this by analogy with T-161 §8.
 */
export const PRODUCTION_QTY_EPS: Quantity = quantity('0.010');

export interface ProductionInputLine {
  readonly itemId: string;
  readonly quantity: string;
  readonly unit: string;
  /** Resolved by the caller before validation — an id that does not resolve is a HARD block
   *  (§10.3), not something this pure module can look up itself. */
  readonly resolved: boolean;
  readonly isActive: boolean;
  /** For a `convert`, the source's own `parent_slab_item_id` (null if it has none). Ignored for
   *  `slice`/`cook`. */
  readonly parentSlabItemId?: string | null;
  /** `true` when the item's `kind` is `meat_slab` — the convert-lineage "has a slab" checks need
   *  to tell a genuinely-slabless item apart from one whose slab id happens to be null. */
  readonly category?: string | null;
  /** T-409: the item's name, so a refusal can name it. Falls back to the id. */
  readonly name?: string | null;
}

export interface ProductionOutputLine {
  readonly itemId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly resolved: boolean;
  readonly isActive: boolean;
  /** The output's own `parent_slab_item_id`, if it has one — §10.4's lineage-mismatch SOFT
   *  warning compares this against the input's. */
  readonly parentSlabItemId?: string | null;
  readonly category?: string | null;
  readonly name?: string | null;
}

export interface ValidateLinesInput {
  readonly kind: 'slice' | 'cook' | 'convert';
  readonly inputs: readonly ProductionInputLine[];
  readonly outputs: readonly ProductionOutputLine[];
}

export type ValidateResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

function parseQty(raw: string, label: string): Quantity | null {
  const trimmed = raw.trim();
  // §10.3: non-numeric is refused SEPARATELY from non-positive — both are HARD blocks, but a
  // caller reading the message should not have to guess which one fired.
  if (!/^-?\d+(\.\d{1,3})?$/.test(trimmed)) return null;
  // T-371 G3: minted by the one `decimal()`, never cast. The regex above admits only (14,3)-shaped strings, so the only
  // refusal left is a value past numeric(14,3)'s 11 integer digits, treated here as not a usable quantity.
  try {
    return quantity(trimmed);
  } catch {
    return null;
  }
}

/**
 * T-409 R1 - a slice takes only a meat slab and makes only sliced meat (HARD). Pure, and exported so
 * `createProductionDraft` and `editPostedProduction` can refuse before anything is written; the same rule runs inside
 * `validateProductionLines`, so post refuses too. A line with no category is refused, never waved through as unknown.
 * Only resolved lines are judged here (an unresolved id is refused by the caller's own check).
 */
export function validateSliceCategories(
  inputs: readonly ProductionInputLine[],
  outputs: readonly ProductionOutputLine[],
): ValidateResult {
  for (const line of inputs) {
    if (!line.resolved || line.category === 'meat_slab') continue;
    const name = line.name?.trim() || line.itemId;
    if (line.category === 'meat_sliced') {
      return { ok: false, reason: `Slicing takes a meat slab. '${name}' is sliced meat; use Convert to re-cut it.` };
    }
    return { ok: false, reason: `Slicing takes a meat slab. '${name}' is not a slab.` };
  }
  for (const line of outputs) {
    if (!line.resolved || line.category === 'meat_sliced') continue;
    const name = line.name?.trim() || line.itemId;
    return { ok: false, reason: `Slicing makes sliced meat. '${name}' is not sliced meat.` };
  }
  return { ok: true, warnings: [] };
}

/**
 * The shared shape both `slice`/`cook` and `convert` run through — every HARD rule in §10.3 plus
 * the unit-conversion block, and every SOFT warning in §10.4. `convert`'s own extra five-check
 * lineage rule (§10.5) is `validateConvertLineage`, run separately by the caller because it needs
 * the parent-slab fields this generic pass does not otherwise require.
 */
export function validateProductionLines(input: ValidateLinesInput): ValidateResult {
  const warnings: string[] = [];

  if (input.kind === 'slice') {
    const categories = validateSliceCategories(input.inputs, input.outputs);
    if (!categories.ok) return categories;
  }

  if (input.outputs.length === 0) {
    // §10.3 / invariant 14: a run with no outputs writes off the whole input as loss — that is a
    // wastage record, not a production run.
    return { ok: false, reason: 'a production run needs at least one output — record a wastage instead' };
  }
  if (input.inputs.length === 0) {
    return { ok: false, reason: 'a production run needs at least one input' };
  }

  // ⭐ Every line's quantity is converted to this run's common base unit (the FIRST input line's
  // own unit) AS IT IS SUMMED — the overage check below compares like with like. Converting only
  // AFTER summing raw numbers would compare "10 kg" against "9500 g" as if both were 10 and 9500
  // of the same thing, which is exactly the DEF-093 class of error one level up.
  const baseUnit = input.inputs[0]!.unit.trim();

  const inputItemIds = new Set<string>();
  let sourceQuantity: Quantity = ZERO_QUANTITY;

  for (const line of input.inputs) {
    if (!line.resolved) {
      // §10.3 / invariant 16: an unresolvable source is a HARD reject.
      return { ok: false, reason: `input item ${line.itemId} does not resolve — cutting from a slab that does not exist` };
    }
    const qty = parseQty(line.quantity, 'input');
    if (qty === null) {
      return { ok: false, reason: `input line for ${line.itemId} has a non-numeric quantity: "${line.quantity}"` };
    }
    if (!isPositiveQuantity(qty)) {
      return { ok: false, reason: `input line for ${line.itemId} must have a quantity greater than zero` };
    }
    if (!line.isActive) {
      warnings.push(`input item ${line.itemId} is inactive`);
    }
    // Unit-conversion HARD block (§8 invariant 4): every line's unit must convert to the run's
    // common base — g<->kg, ml<->ltr only. A pairing that does not convert BLOCKS; it is never
    // guessed at or passed through unconverted (DEF-093).
    const inBase = convertUnit(qty, line.unit, baseUnit);
    if (inBase === null) {
      return {
        ok: false,
        reason: `"${line.unit}" for item ${line.itemId} cannot be converted to "${baseUnit}" — pcs<->pack, pcs<->box and kg<->ltr all need a per-item factor this module refuses to guess`,
      };
    }
    inputItemIds.add(line.itemId);
    sourceQuantity = addQuantity(sourceQuantity, inBase);
  }

  const outputItemIds = new Set<string>();
  let outputQuantity: Quantity = ZERO_QUANTITY;

  for (const line of input.outputs) {
    if (!line.resolved) {
      return { ok: false, reason: `output item ${line.itemId} does not resolve` };
    }
    const qty = parseQty(line.quantity, 'output');
    if (qty === null) {
      return { ok: false, reason: `output line for ${line.itemId} has a non-numeric quantity: "${line.quantity}"` };
    }
    if (!isPositiveQuantity(qty)) {
      return { ok: false, reason: `output line for ${line.itemId} must have a quantity greater than zero` };
    }
    if (!line.isActive) {
      warnings.push(`output item ${line.itemId} is inactive`);
    }
    if (input.kind === 'convert') {
      // §10.4's SOFT source-category check applies to `slice`/`cook`; a convert's own five-check
      // lineage rule (validateConvertLineage) already covers "has a slab" more precisely.
    } else if (!line.parentSlabItemId) {
      warnings.push(`output ${line.itemId} has no source slab set`);
    }
    const outBase = convertUnit(qty, line.unit, baseUnit);
    if (outBase === null) {
      return {
        ok: false,
        reason: `"${line.unit}" for item ${line.itemId} cannot be converted to "${baseUnit}" — pcs<->pack, pcs<->box and kg<->ltr all need a per-item factor this module refuses to guess`,
      };
    }
    outputItemIds.add(line.itemId);
    outputQuantity = addQuantity(outputQuantity, outBase);
  }

  // §10.3 / invariant 15: the input product may not also be an output.
  for (const id of outputItemIds) {
    if (inputItemIds.has(id)) {
      return { ok: false, reason: `item ${id} cannot be both an input and an output of the same run` };
    }
  }

  // Invariant 3 / §10.2: output quantity exceeding input, past the SCALE tolerance, is a HARD
  // block — now comparing two quantities in the SAME base unit.
  const overage = subtractQuantity(outputQuantity, sourceQuantity);
  if (compareQuantity(overage, PRODUCTION_QTY_EPS) > 0) {
    return {
      ok: false,
      reason: `outputs total ${outputQuantity} ${baseUnit} against ${sourceQuantity} ${baseUnit} of input — output cannot exceed input`,
    };
  }

  return { ok: true, warnings };
}

export interface ConvertLineageInput {
  readonly sourceItemId: string | null;
  readonly targetItemId: string | null;
  readonly sourceParentSlabItemId: string | null;
  readonly targetParentSlabItemId: string | null;
}

/**
 * §10.5 — five checks, not one. ⚠️ The two "has a slab" checks are SEPARATE from the "same slab"
 * check because a null slab on either side would otherwise compare equal to a null on the other
 * and pass — two slabless items are not "the same lineage", they are two facts this function must
 * not conflate.
 */
export function validateConvertLineage(input: ConvertLineageInput): ValidateResult {
  if (!input.sourceItemId || !input.targetItemId) {
    return { ok: false, reason: 'a convert needs both a source and a target product' };
  }
  if (input.sourceItemId === input.targetItemId) {
    return { ok: false, reason: 'a convert cannot target the same product it cuts from' };
  }
  if (!input.sourceParentSlabItemId) {
    return { ok: false, reason: `source ${input.sourceItemId} has no parent slab — a convert only moves between children of one slab` };
  }
  if (!input.targetParentSlabItemId) {
    return { ok: false, reason: `target ${input.targetItemId} has no parent slab — a convert only moves between children of one slab` };
  }
  if (input.sourceParentSlabItemId !== input.targetParentSlabItemId) {
    // Invariant 5 / test 6: refused between children of DIFFERENT slabs.
    return { ok: false, reason: 'a convert can only move between two children of the SAME slab' };
  }
  return { ok: true, warnings: [] };
}

export interface ValueIdentityInput {
  /** Σ FIFO cost of the consumed input lines. */
  readonly inputCost: Money;
  readonly labourCost: Money;
  readonly sourceQuantity: Quantity;
  readonly outputQuantity: Quantity;
}

export interface ValueIdentityResult {
  /** Clamped at zero — invariant 19. */
  readonly yieldGapQuantity: Quantity;
  /** Clamped at zero and never larger than `inputCost + labourCost` — a value that made the
   *  output negative would be exactly the "negative loss posts a stock-IN leg" invariant 19
   *  forbids, moved one level up from quantity to money. */
  readonly yieldLossValue: Money;
  readonly outputTotalValue: Money;
}

/** Half-up on the absolute value of a bigint ratio — the same shape `commissary/transfer.ts`'s
 *  `proportionOfCost` uses for "this share of that total cost", duplicated locally as a generic
 *  money-proportion primitive (not the conversion TABLE §4 forbids a second copy of). Uses the
 *  REAL exported `toThousandths`/`toCentavos`/`fromCentavos` — no private bigint mirrors. */
function proportionalValue(total: Money, part: Quantity, whole: Quantity): Money {
  const w = toThousandths(whole);
  if (w === 0n) return ZERO;
  const p = toThousandths(part);
  if (p >= w) return total;
  const cents = toCentavos(total);
  const scaled = cents * p * 2n;
  const roundedDoubled = scaled + w;
  const rounded = roundedDoubled / (w * 2n);
  return fromCentavos(rounded);
}

/**
 * Invariant 2 / §3 / §10.1 — the value identity. `Total output value = total input value +
 * labour − yield-loss value`, checked at post; a mismatch is a HARD block.
 *
 * ⭐ **The yield gap's VALUE, not just its quantity.** v1 books the gap as a ledger-only memo
 * (never touching a balance twice); v2 must land it somewhere real — `Dr 5300` for what the gap
 * is WORTH, valued at the input's own blended rate (`inputCost / sourceQuantity`), never at the
 * output's derived rate (that would be circular) and never inflating the output's own unit cost
 * (§3: "it does not silently inflate the output's unit cost").
 *
 * ⚠️ **Spec-defect note (reported per bible §3.4a, not silently reconciled): T-176 §9 test 1's own
 * worked numbers (`Dr 1330 30,903 / Dr 5300 97`, ₱318.59/kg) do not arithmetically reconcile with
 * this formula, with the plain-language description immediately above them, OR with §3's own
 * `total input cost / output quantity = 310/kg` statement applied to the very same T-133 baseline
 * this test cites. No allocation formula this implementer could construct produces exactly
 * `Dr 5300 97` from a 3 kg gap costed at any rate derivable from the other stated figures. This
 * function implements the formula the PROSE states, which reduces correctly to T-133's own
 * ₱310/kg when there is no yield loss (labour, no gap) — the one part of the worked example this
 * implementer COULD verify independently. See the task report for the corrected worked numbers
 * used in this lane's own integration test.
 */
export function computeValueIdentity(input: ValueIdentityInput): ValueIdentityResult {
  const rawGap = subtractQuantity(input.sourceQuantity, input.outputQuantity);
  const yieldGapQuantity = isPositiveQuantity(rawGap) ? rawGap : ZERO_QUANTITY;

  let yieldLossValue: Money = ZERO;
  if (isPositiveQuantity(yieldGapQuantity) && isPositiveQuantity(input.sourceQuantity)) {
    yieldLossValue = proportionalValue(input.inputCost, yieldGapQuantity, input.sourceQuantity);
  }

  const totalIn = add(input.inputCost, input.labourCost);
  // Never let the plug exceed what came in — a value that made the output negative is the same
  // shape of bug invariant 19 forbids at the quantity level, one layer up.
  if (compare(yieldLossValue, totalIn) > 0) yieldLossValue = totalIn;

  const outputTotalValue = subtract(totalIn, yieldLossValue);
  return { yieldGapQuantity, yieldLossValue, outputTotalValue };
}
