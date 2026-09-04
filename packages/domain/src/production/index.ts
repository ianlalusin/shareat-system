/**
 * Production — the document and posting layer. T-176.
 *
 * ⭐ **Draft -> post -> void/edit, and only post moves anything** — the same split T-168's usage
 * document and T-167's transfers already use. `authorize()` is this file's job; the pure math
 * lives in `validate.ts` and `unit-conversion.ts`; the FIFO/ledger primitives are T-161/T-162/
 * T-164's (`consume`, `reverseConsumption`, `postEntry`, `reverseEntry`) — never re-implemented.
 *
 * ## Account routing — reuses the ONE existing table, never a second copy
 *
 * Every leg's account comes from `INVENTORY_ACCOUNT_BY_ITEM_KIND` (`stock/receipt-posting.ts`),
 * exactly as `commissary/transfer.ts` and `stock/usage.ts` already do — an output line's account
 * is whatever ITS OWN item's `kind` maps to, never a hardcoded `1330`. ⚠️ **Spec-defect note,
 * reported per bible §3.4a:** T-176 §3's worked example books a `slice` run's output to `1330`
 * ("prepped/commissary goods"), but §6's own contract requires a sliced product's `kind` to stay
 * `meat_sliced` (the `parent_slab_item_id` CHECK demands it), and `meat_sliced` already maps to
 * `1310` in the existing, shared account table — the same bucket as the slab it came from. No
 * item can carry `kind = 'prepped'` today (`items_kind_check` forbids it, and adding it is
 * outside this task's stated Scope). Reusing the existing map rather than hardcoding `1330` is
 * the standard-and-boring choice (bible §0.2) and keeps ONE account router in the codebase; the
 * practical effect is that a `slice` run's output posts to `1310`, alongside its slab, until a
 * `prepped` kind is deliberately added. See the task report for the two ways to resolve this.
 *
 * ## The value identity and DEF-093's actual fix are in `validate.ts` / `unit-conversion.ts`
 *
 * This file's job is to CALL them, consume/create real layers accordingly, and post the entry
 * that has to balance to what they computed — never to recompute the arithmetic itself.
 */
import { authorize, type Actor } from '@shareat/auth';
import { productionRepo, stockLayersRepo, stockLedgerRepo, journalRepo, type Tx } from '@shareat/db';
import { stockLayers as stockLayersTable } from '@shareat/db/schema';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { add, compare, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { consume, reverseConsumption } from '../stock/consume';
import { lineCost } from '../stock/layers';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import { WASTAGE_ACCOUNT } from '../stock/consumption-posting';
import {
  addQuantity,
  compareQuantity,
  fromThousandths,
  isPositiveQuantity,
  quantity,
  subtractQuantity,
  toThousandths,
  ZERO_QUANTITY,
  type Quantity,
} from '../stock/quantity';
import { convertUnit } from './unit-conversion';
import {
  computeValueIdentity,
  PRODUCTION_QTY_EPS,
  validateConvertLineage,
  validateProductionLines,
  type ProductionInputLine,
  type ProductionOutputLine,
} from './validate';

/** §3. "6xxx processing labour" — the spec leaves the exact code to this implementation. 6100
 *  ("Salaries and wages") is the natural target: labour was already expensed there through
 *  payroll, and crediting it here CAPITALISES it into the output's cost, the same mechanism
 *  `commissary/transfer.ts`'s `5175` uses to net a commissary's processing labour to zero. */
export const PROCESSING_LABOUR_ACCOUNT = '6100';
// ⭐ `WASTAGE_ACCOUNT` ('5300') is reused from `stock/consumption-posting.ts` (T-164) rather than
// redeclared — one account router, never a second copy under a different name.

// -----------------------------------------------------------------------------------------
// §7 — the slicer-payment lock, as a derived query. Phase 5's own table does not exist yet;
// this predicate is the coupling point, written now so Phase 5 inherits a query to replace, not
// a design problem. ⛔ NOT a column on production_records (DEF-075's pattern) and ⛔ NOT a call
// Phase 5 makes into inventory — this file calls OUT to what will be Phase 5's table, never the
// other direction.
// -----------------------------------------------------------------------------------------
export interface SlicerPaymentLockInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly producedOn: string;
}

export async function hasLiveSlicerPaymentCovering(_tx: Tx, _input: SlicerPaymentLockInput): Promise<boolean> {
  // STUB (§7). Until Phase 5's payment table exists, every production record is editable —
  // replace this body with a real query (WHERE status <> 'void' AND date range covers
  // producedOn) once that table lands. Never inline a call into this module from Phase 5 itself.
  return false;
}

// -----------------------------------------------------------------------------------------
// Recipes — configuration, manager+ (reuses `manage_items`: master-data curation, same bar as
// the item master a recipe references).
// -----------------------------------------------------------------------------------------
export interface RecipeLineInput {
  readonly itemId: string;
  readonly quantity: string;
  readonly unit: string;
}

export interface CreateRecipeInput {
  readonly orgId: string;
  readonly name: string;
  readonly outputItemId: string;
  readonly outputQuantity: string;
  readonly lines: readonly RecipeLineInput[];
}

export type RecipeOutcome = { readonly ok: true; readonly recipeId: string } | { readonly ok: false; readonly reason: string };

export async function createRecipe(tx: Tx, actor: Actor, input: CreateRecipeInput): Promise<RecipeOutcome> {
  await authorize(tx, actor, 'manage_items', {});
  if (!input.name.trim()) return { ok: false, reason: 'a recipe needs a name' };
  if (input.lines.length === 0) return { ok: false, reason: 'a recipe needs at least one ingredient line' };
  if (!isPositiveQuantity(quantity(input.outputQuantity))) {
    return { ok: false, reason: 'a recipe\'s output quantity must be greater than zero' };
  }
  for (const line of input.lines) {
    if (!isPositiveQuantity(quantity(line.quantity))) {
      return { ok: false, reason: `ingredient ${line.itemId} must have a quantity greater than zero` };
    }
  }
  const { id: recipeId } = await productionRepo.insertRecipe(tx, {
    orgId: input.orgId,
    name: input.name.trim(),
    outputItemId: input.outputItemId,
    outputQuantity: input.outputQuantity,
    createdBy: actor.personId,
  });
  await productionRepo.insertRecipeLines(tx, recipeId, input.lines);
  return { ok: true, recipeId };
}

// -----------------------------------------------------------------------------------------
// Drafting a production record — staff-open (`record_stock_movement`), same bar as usage's own
// draft step: the floor worker recording what they cut or cooked does not need a manager present.
// -----------------------------------------------------------------------------------------
export interface DraftLineInput {
  readonly itemId: string;
  readonly quantity: string;
  readonly unit: string;
}

export interface CreateProductionDraftInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly kind: 'slice' | 'cook' | 'convert';
  readonly recipeId?: string | null;
  readonly producedOn: string;
  readonly labourCost?: string;
  readonly inputs: readonly DraftLineInput[];
  readonly outputs: readonly DraftLineInput[];
}

// ⚠️ Named `ProductionDraftOutcome`, not `DraftOutcome` — `stock/usage-records.ts` already
// exports a `DraftOutcome` and the domain barrel is `export *`; a same-named type here would be
// a duplicate-export compile error, not a shadow.
export type ProductionDraftOutcome = { readonly ok: true; readonly recordId: string } | { readonly ok: false; readonly reason: string };

export async function createProductionDraft(tx: Tx, actor: Actor, input: CreateProductionDraftInput): Promise<ProductionDraftOutcome> {
  await authorize(tx, actor, 'record_stock_movement', { storeId: input.storeId });

  if (input.inputs.length === 0) return { ok: false, reason: 'a production run needs at least one input' };
  if (input.outputs.length === 0) {
    return { ok: false, reason: 'a production run needs at least one output — record a wastage instead' };
  }

  const { id: recordId } = await productionRepo.insertProductionRecord(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    locationId: input.locationId,
    kind: input.kind,
    recipeId: input.recipeId ?? null,
    producedOn: input.producedOn,
    labourCost: input.labourCost ?? '0',
    createdBy: actor.personId,
  });

  await productionRepo.insertProductionRecordLines(tx, recordId, 1, [
    ...input.inputs.map((l) => ({ direction: 'out' as const, itemId: l.itemId, quantity: l.quantity, unit: l.unit })),
    ...input.outputs.map((l) => ({ direction: 'in' as const, itemId: l.itemId, quantity: l.quantity, unit: l.unit })),
  ]);

  return { ok: true, recordId };
}

/**
 * Scales a recipe to `targetOutputQuantity`, converting every ingredient's recipe-line unit into
 * the ITEM's OWN base unit via `unit-conversion.ts` — the exact call DEF-093 names as missing in
 * v1 (`resolveUnitConversion(line.unit, line.unit)`, an identity that can never convert).
 */
export interface ScaleRecipeInput {
  readonly recipeLines: readonly { itemId: string; quantity: string; unit: string; itemBaseUnit: string }[];
  readonly recipeOutputQuantity: string;
  readonly targetOutputQuantity: string;
}
export type ScaleRecipeOutcome =
  | { readonly ok: true; readonly lines: readonly { itemId: string; quantity: string; unit: string }[] }
  | { readonly ok: false; readonly reason: string };

export function scaleRecipeToTarget(input: ScaleRecipeInput): ScaleRecipeOutcome {
  const recipeOut = quantity(input.recipeOutputQuantity);
  const target = quantity(input.targetOutputQuantity);
  if (!isPositiveQuantity(target)) return { ok: false, reason: 'the target output quantity must be greater than zero' };

  const lines: { itemId: string; quantity: string; unit: string }[] = [];
  for (const line of input.recipeLines) {
    // scaled = line.quantity * target / recipeOutputQuantity, in the LINE's own unit first...
    const scaledInLineUnit = scaleQuantity(quantity(line.quantity), target, recipeOut);
    // ...then converted to the ITEM's base unit. A pairing that cannot convert BLOCKS (DEF-093).
    const converted = convertUnit(scaledInLineUnit, line.unit, line.itemBaseUnit);
    if (converted === null) {
      return {
        ok: false,
        reason: `recipe line for item ${line.itemId} is in "${line.unit}", which cannot be converted to its base unit "${line.itemBaseUnit}"`,
      };
    }
    lines.push({ itemId: line.itemId, quantity: converted, unit: line.itemBaseUnit });
  }
  return { ok: true, lines };
}

function scaleQuantity(value: Quantity, numeratorQty: Quantity, denominatorQty: Quantity): Quantity {
  // value * numeratorQty / denominatorQty, exact to 3dp, rounded half-up once at the end.
  const v = toThousandths(value);
  const n = toThousandths(numeratorQty);
  const d = toThousandths(denominatorQty);
  if (d === 0n) return ZERO_QUANTITY;
  const scaled = v * n; // scale is (1000*1000)=10^6 too big; divide by d then by 1000 (numerator's own scale)
  const perThousand = scaled / d; // still one factor of 1000 too large
  const rounded = (perThousand + 500n) / 1000n;
  return fromThousandths(rounded);
}

// -----------------------------------------------------------------------------------------
// Posting — the engine both the initial post and an edit's re-post share.
// -----------------------------------------------------------------------------------------
interface ResolvedItem {
  readonly id: string;
  readonly kind: string;
  readonly baseUnit: string;
  readonly status: string;
  readonly parentSlabItemId: string | null;
}

async function resolveItems(tx: Tx, orgId: string, ids: readonly string[]): Promise<Map<string, ResolvedItem>> {
  const rows = await productionRepo.getItemsForProduction(tx, orgId, ids);
  return new Map(rows.map((r) => [r.id, r]));
}

interface PostEngineLine {
  readonly lineRowId?: string;
  readonly itemId: string;
  readonly quantity: Quantity;
  readonly unit: string;
}

export interface PostEngineResult {
  readonly ok: true;
  readonly journalEntryId: string | null;
  readonly warnings: readonly string[];
  readonly inputMovements: readonly { itemId: string; movementId: string; quantity: Quantity; unit: string }[];
  readonly outputMovements: readonly { itemId: string; movementId: string; quantity: Quantity; unit: string }[];
}
export type PostEngineOutcome = PostEngineResult | { readonly ok: false; readonly reason: string };

/**
 * Runs the whole conversion: validate, consume inputs, create/route output layers, post the one
 * journal entry (never for `convert` — invariant 5), and hand back the movement ids the caller
 * writes onto `production_record_lines`.
 */
async function runProductionPosting(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    locationId: string;
    kind: 'slice' | 'cook' | 'convert';
    recordId: string;
    producedOn: string;
    labourCost: Money;
    inputs: readonly PostEngineLine[];
    outputs: readonly PostEngineLine[];
    postedBy: string;
    idempotencySuffix: string;
  },
): Promise<PostEngineOutcome> {
  const allIds = [...new Set([...input.inputs.map((l) => l.itemId), ...input.outputs.map((l) => l.itemId)])];
  const items = await resolveItems(tx, input.orgId, allIds);

  const inputLines: ProductionInputLine[] = input.inputs.map((l) => {
    const item = items.get(l.itemId);
    return {
      itemId: l.itemId,
      quantity: l.quantity,
      unit: l.unit,
      resolved: item !== undefined,
      isActive: item?.status === 'active',
      parentSlabItemId: item?.parentSlabItemId ?? null,
      category: item?.kind ?? null,
    };
  });
  const outputLines: ProductionOutputLine[] = input.outputs.map((l) => {
    const item = items.get(l.itemId);
    return {
      itemId: l.itemId,
      quantity: l.quantity,
      unit: l.unit,
      resolved: item !== undefined,
      isActive: item?.status === 'active',
      parentSlabItemId: item?.parentSlabItemId ?? null,
      category: item?.kind ?? null,
    };
  });

  const validated = validateProductionLines({ kind: input.kind, inputs: inputLines, outputs: outputLines });
  if (!validated.ok) return validated;
  const warnings = [...validated.warnings];

  // ⭐ DEF-093's fix, applied at the POSTING boundary too: every line's ENTERED quantity/unit is
  // converted to its OWN ITEM's base unit here, once — `consume`/`insertMovement`/`createLayer`
  // all store quantities in the item's base unit with no unit column of their own (the same
  // convention `deliveries/receive.ts` already uses for a supplier's purchase unit). A line whose
  // unit does not convert already failed `validateProductionLines` above, so every conversion
  // here is expected to succeed — the assertion catches the codebase disagreeing with itself.
  const toBaseUnit = (lines: readonly PostEngineLine[]): PostEngineLine[] =>
    lines.map((l) => {
      const item = items.get(l.itemId)!;
      const converted = convertUnit(l.quantity, l.unit, item.baseUnit);
      if (converted === null) {
        throw new Error(`production posting: "${l.unit}" for item ${l.itemId} does not convert to its base unit "${item.baseUnit}" — validateProductionLines should have refused this already`);
      }
      return { ...l, quantity: converted, unit: item.baseUnit };
    });
  const baseInputs = toBaseUnit(input.inputs);
  const baseOutputs = toBaseUnit(input.outputs);

  if (input.kind === 'convert') {
    if (input.inputs.length !== 1 || input.outputs.length !== 1) {
      return { ok: false, reason: 'a convert moves exactly one source into exactly one target' };
    }
    const source = items.get(input.inputs[0]!.itemId);
    const target = items.get(input.outputs[0]!.itemId);
    const lineage = validateConvertLineage({
      sourceItemId: source?.id ?? null,
      targetItemId: target?.id ?? null,
      sourceParentSlabItemId: source?.parentSlabItemId ?? null,
      targetParentSlabItemId: target?.parentSlabItemId ?? null,
    });
    if (!lineage.ok) return lineage;
  } else {
    // §10.4 SOFT lineage-mismatch check for slice/cook: an output naming a slab different from
    // any input's is normal business (trimmings pooling) — warn, never block.
    //
    // ⚠️ An input's "own slab" is either ITS OWN id (when the input IS a slab — the ordinary
    // `slice` case: cutting straight off `meat_slab`) or its `parentSlabItemId` (when the input
    // is itself already a sliced/trimmed item being re-processed). Comparing only
    // `parentSlabItemId` would leave this warning permanently unreachable for the most common
    // shape — a slab has no `parentSlabItemId` of its own (the CHECK forbids it).
    const inputSlabs = new Set(
      inputLines.flatMap((l) => [l.category === 'meat_slab' ? l.itemId : null, l.parentSlabItemId]).filter((v): v is string => !!v),
    );
    for (const out of outputLines) {
      if (out.parentSlabItemId && inputSlabs.size > 0 && !inputSlabs.has(out.parentSlabItemId)) {
        warnings.push(`output ${out.itemId}'s source slab differs from this run's input — trimmings pooling across primals`);
      }
    }
  }

  // ---- Consume every input, oldest layers first (T-161/T-162's own primitive). ----------------
  const inputMovements: { itemId: string; movementId: string; quantity: Quantity; unit: string }[] = [];
  const costByAccount = new Map<string, Money>();
  let totalInputCost: Money = ZERO;
  let sourceQuantity: Quantity = ZERO_QUANTITY;

  for (const line of baseInputs) {
    const item = items.get(line.itemId)!;
    const account = INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
    if (!account) {
      if (inputMovements.length > 0) {
        throw new Error(`production posting: item kind "${item.kind}" has no inventory account, refused after stock was written`);
      }
      return { ok: false, reason: `item kind "${item.kind}" has no inventory account in COA-ALIGNMENT §4.1` };
    }
    // ⭐ §10.2 / invariant 17/18. `PRODUCTION_QTY_EPS` is a SCALE tolerance: cutting 10.005 from
    // 10.000 actually on the shelf is two scales disagreeing by five grams, not a real shortfall.
    // `consume()`/`planConsumption` have no tolerance of their own (an exact refusal is correct
    // for every OTHER caller) — production is the one caller that must CLAMP the request down to
    // what is actually there before asking, rather than asking `consume()` to bend its own rule.
    const openLayers = await stockLayersRepo.openLayersForUpdate(tx, line.itemId, input.storeId);
    const available = openLayers.reduce(
      (sum, l) => addQuantity(sum, quantity(l.remainingQuantity)),
      ZERO_QUANTITY,
    );
    let consumeQty = line.quantity;
    if (compareQuantity(line.quantity, available) > 0) {
      const shortfall = subtractQuantity(line.quantity, available);
      if (compareQuantity(shortfall, PRODUCTION_QTY_EPS) <= 0) {
        // Within tolerance — take exactly what is there, never invent the missing grams.
        consumeQty = available;
      }
      // Past tolerance: leave `consumeQty` as requested so `consume()` below refuses it with its
      // own real "only X available" message — a genuine shortfall, not scale noise.
    }

    const result = await consume(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      itemId: line.itemId,
      quantity: consumeQty,
      movedAt: new Date(`${input.producedOn}T00:00:00Z`),
      kind: 'production_out',
      sourceType: `production_${input.idempotencySuffix}`,
      // ⭐ DEF-140's own lesson: `source_id` is a plain uuid column, never a composite string.
      // Prefer the LINE's own id (so two lines touching one (item, location) never collide on
      // `stock_movements_source_pair_key`); fall back to the record id only when no line row
      // exists yet (a fresh edit-revision's lines are inserted with their movement already known
      // — see `editPostedProduction`).
      sourceId: line.lineRowId ?? input.recordId,
      createdBy: input.postedBy,
    });
    if (!result.ok) {
      if (inputMovements.length > 0) {
        throw new Error(`production posting: refused after stock was written — ${result.reason}`);
      }
      return result;
    }
    inputMovements.push({ itemId: line.itemId, movementId: result.movementId, quantity: consumeQty, unit: line.unit });
    totalInputCost = add(totalInputCost, result.totalCost);
    sourceQuantity = addQuantity(sourceQuantity, consumeQty);
    costByAccount.set(account, add(costByAccount.get(account) ?? ZERO, result.totalCost));
  }

  let outputQuantity: Quantity = ZERO_QUANTITY;
  for (const line of baseOutputs) outputQuantity = addQuantity(outputQuantity, line.quantity);

  // ---- `convert` — a pure count move. No journal entry, no value math (invariant 5). ----------
  if (input.kind === 'convert') {
    // The target layer carries the SAME per-unit rate the source carried — a re-cut changes the
    // count, never the value (zero GL impact, §4).
    const rate = compareQuantity(sourceQuantity, ZERO_QUANTITY) > 0 ? divideMoneyByQty(totalInputCost, sourceQuantity) : '0.0000';
    const outputMovements: { itemId: string; movementId: string; quantity: Quantity; unit: string }[] = [];
    for (const line of baseOutputs) {
      const movement = await stockLedgerRepo.insertMovement(tx, {
        orgId: input.orgId,
        storeId: input.storeId,
        locationId: input.locationId,
        itemId: line.itemId,
        movedAt: new Date(`${input.producedOn}T00:00:00Z`),
        quantity: line.quantity,
        kind: 'production_in',
        sourceType: `production_${input.idempotencySuffix}`,
        sourceId: line.lineRowId ?? input.recordId,
        createdBy: input.postedBy,
      });
      await stockLayersRepo.createLayer(tx, {
        orgId: input.orgId,
        storeId: input.storeId,
        itemId: line.itemId,
        receivedAt: new Date(`${input.producedOn}T00:00:00Z`),
        quantity: line.quantity,
        unitCost: rate,
        source: 'production',
        sourceId: input.recordId,
        movementId: movement.id,
      });
      outputMovements.push({ itemId: line.itemId, movementId: movement.id, quantity: line.quantity, unit: line.unit });
    }
    return { ok: true, journalEntryId: null, warnings, inputMovements, outputMovements };
  }

  // ---- `slice` / `cook` — the value identity, the yield gap, one journal entry. ----------------
  const identity = computeValueIdentity({
    inputCost: totalInputCost,
    labourCost: input.labourCost,
    sourceQuantity,
    outputQuantity,
  });

  // Per-output-line value, proportional to quantity, LAST line absorbs the rounding remainder so
  // the sum ties to `identity.outputTotalValue` to the centavo (invariant 2) — the same
  // "round per line, never the total" discipline `stock/layers.ts` already uses.
  const outputRate =
    compareQuantity(outputQuantity, ZERO_QUANTITY) > 0
      ? divideMoneyByQty(identity.outputTotalValue, outputQuantity)
      : '0.0000';

  const outputMovements: { itemId: string; movementId: string; quantity: Quantity; unit: string }[] = [];
  const debitByAccount = new Map<string, Money>();
  let allocated: Money = ZERO;

  for (let i = 0; i < baseOutputs.length; i++) {
    const line = baseOutputs[i]!;
    const item = items.get(line.itemId)!;
    const account = INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind];
    if (!account) {
      throw new Error(`production posting: output item kind "${item.kind}" has no inventory account, refused after stock was written`);
    }
    const isLast = i === baseOutputs.length - 1;
    const lineValue = isLast ? subtract(identity.outputTotalValue, allocated) : lineCost(line.quantity, outputRate);
    allocated = add(allocated, lineValue);

    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      itemId: line.itemId,
      movedAt: new Date(`${input.producedOn}T00:00:00Z`),
      quantity: line.quantity,
      kind: 'production_in',
      sourceType: `production_${input.idempotencySuffix}`,
      sourceId: line.lineRowId ?? input.recordId,
      createdBy: input.postedBy,
    });
    // ⭐ Layered at THIS line's own rate (value / quantity) — never the blanket `outputRate`
    // directly, so the layer's own (quantity x unitCost) matches the entry's line to the centavo.
    const layerUnitCost = compareQuantity(line.quantity, ZERO_QUANTITY) > 0 ? divideMoneyByQty(lineValue, line.quantity) : '0.0000';
    await stockLayersRepo.createLayer(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      itemId: line.itemId,
      receivedAt: new Date(`${input.producedOn}T00:00:00Z`),
      quantity: line.quantity,
      unitCost: layerUnitCost,
      source: 'production',
      sourceId: input.recordId,
      movementId: movement.id,
    });
    outputMovements.push({ itemId: line.itemId, movementId: movement.id, quantity: line.quantity, unit: line.unit });
    debitByAccount.set(account, add(debitByAccount.get(account) ?? ZERO, lineValue));
  }

  const lines: PostEntryLine[] = [];
  for (const [account, value] of debitByAccount) {
    if (compare(value, ZERO) > 0) lines.push({ accountCode: account, storeId: input.storeId, debit: value });
  }
  if (compare(identity.yieldLossValue, ZERO) > 0) {
    lines.push({ accountCode: WASTAGE_ACCOUNT, storeId: input.storeId, debit: identity.yieldLossValue });
  }
  for (const [account, cost] of costByAccount) {
    if (compare(cost, ZERO) > 0) lines.push({ accountCode: account, storeId: input.storeId, credit: cost });
  }
  if (compare(input.labourCost, ZERO) > 0) {
    lines.push({ accountCode: PROCESSING_LABOUR_ACCOUNT, storeId: input.storeId, credit: input.labourCost });
  }

  const posted = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.producedOn,
    sourceType: `production_${input.idempotencySuffix}`,
    sourceId: input.recordId,
    idempotencyKey: `production:${input.recordId}:${input.idempotencySuffix}`,
    memo: input.kind === 'cook' ? 'Production — recipe batch' : 'Production — slicing run',
    postedBy: input.postedBy,
    lines,
  });

  return { ok: true, journalEntryId: posted.entryId, warnings, inputMovements, outputMovements };
}

/** Money / Quantity -> a numeric(14,4) rate string, half-up. Uses the real exported
 *  `toCentavos`/`toThousandths` — no private bigint mirrors. */
function divideMoneyByQty(total: Money, qty: Quantity): string {
  // rate = total/qty. We want the result as an integer count of TEN-THOUSANDTHS (numeric(14,4)):
  //   rate * 10^4 = (cents/10^2) / (thousandths/10^3) * 10^4 = cents * 10^5 / thousandths.
  const cents = toCentavos(total);
  const thousandths = toThousandths(qty);
  if (thousandths === 0n) return '0.0000';
  const scaled = cents * 100_000n;
  const denom = thousandths;
  const rounded = (scaled + denom / 2n) / denom;
  const negative = rounded < 0n;
  const abs = negative ? -rounded : rounded;
  const whole = abs / 10_000n;
  const frac = (abs % 10_000n).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

// -----------------------------------------------------------------------------------------
// Post — manager+ (`post_production`).
// -----------------------------------------------------------------------------------------
// ⚠️ `ProductionPostOutcome`, not `PostOutcome` — same duplicate-export reason as
// `ProductionDraftOutcome` above (`stock/usage-records.ts` already owns `PostOutcome`).
export type ProductionPostOutcome =
  | { readonly ok: true; readonly journalEntryId: string | null; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export async function postProduction(tx: Tx, actor: Actor, input: { recordId: string }): Promise<ProductionPostOutcome> {
  const record = await productionRepo.getProductionRecord(tx, input.recordId);
  if (!record) return { ok: false, reason: `production record ${input.recordId} does not exist` };
  await authorize(tx, actor, 'post_production', { storeId: record.storeId, orgId: record.orgId });

  if (record.status !== 'draft') return { ok: false, reason: `production record ${input.recordId} is ${record.status}, not draft` };

  const locked = await hasLiveSlicerPaymentCovering(tx, { orgId: record.orgId, storeId: record.storeId, producedOn: record.producedOn });
  if (locked) {
    return { ok: false, reason: 'a live slicer payment covers this date — editing or voiding it now would leave labour expensed against output that no longer exists' };
  }

  const rows = await productionRepo.listProductionRecordLines(tx, record.id, { revision: 1 });
  const inputRows = rows.filter((r) => r.direction === 'out');
  const outputRows = rows.filter((r) => r.direction === 'in');
  const inputs = inputRows.map((r) => ({ lineRowId: r.id, itemId: r.itemId, quantity: quantity(r.quantity), unit: r.unit }));
  const outputs = outputRows.map((r) => ({ lineRowId: r.id, itemId: r.itemId, quantity: quantity(r.quantity), unit: r.unit }));

  const result = await runProductionPosting(tx, {
    orgId: record.orgId,
    storeId: record.storeId,
    locationId: record.locationId,
    kind: record.kind,
    recordId: record.id,
    producedOn: record.producedOn,
    labourCost: record.labourCost as Money,
    inputs,
    outputs,
    postedBy: actor.personId,
    idempotencySuffix: 'post',
  });
  if (!result.ok) return result;

  // ⚠️ Matched by POSITION, never by (itemId, quantity) — two lines can legitimately share both
  // (e.g. two identical output lines), and a value-match would silently mis-assign the second.
  // `runProductionPosting` returns movements in the same order its `inputs`/`outputs` were given.
  for (let i = 0; i < result.inputMovements.length; i++) {
    await productionRepo.setLineMovement(tx, inputRows[i]!.id, result.inputMovements[i]!.movementId);
  }
  for (let i = 0; i < result.outputMovements.length; i++) {
    await productionRepo.setLineMovement(tx, outputRows[i]!.id, result.outputMovements[i]!.movementId);
  }
  await productionRepo.markProductionPosted(tx, record.id, result.journalEntryId, actor.personId, result.warnings);

  return { ok: true, journalEntryId: result.journalEntryId, warnings: result.warnings };
}

// -----------------------------------------------------------------------------------------
// Edit a POSTED record in place — manager+ (`edit_posted_production`). Excluded for `convert`
// (invariant 8) — void and re-create instead.
// -----------------------------------------------------------------------------------------
export interface EditProductionInput {
  readonly recordId: string;
  readonly inputs: readonly DraftLineInput[];
  readonly outputs: readonly DraftLineInput[];
  readonly labourCost?: string;
}
export type EditOutcome =
  | { readonly ok: true; readonly revision: number; readonly journalEntryId: string | null }
  | { readonly ok: false; readonly reason: string };

export async function editPostedProduction(tx: Tx, actor: Actor, input: EditProductionInput): Promise<EditOutcome> {
  const record = await productionRepo.getProductionRecord(tx, input.recordId);
  if (!record) return { ok: false, reason: `production record ${input.recordId} does not exist` };
  await authorize(tx, actor, 'edit_posted_production', { storeId: record.storeId, orgId: record.orgId });

  if (record.status !== 'posted') return { ok: false, reason: `production record ${input.recordId} is ${record.status}, not posted` };
  if (record.kind === 'convert') {
    // Invariant 8's own exclusion, and test 9's "editing a convert is refused".
    return { ok: false, reason: 'a convert record cannot be edited — void it and record a new one' };
  }

  const locked = await hasLiveSlicerPaymentCovering(tx, { orgId: record.orgId, storeId: record.storeId, producedOn: record.producedOn });
  if (locked) {
    return { ok: false, reason: 'a live slicer payment covers this date — editing it now would leave labour expensed against output that no longer exists' };
  }

  const oldLines = await productionRepo.listProductionRecordLines(tx, record.id, { revision: record.revision, unreversedOnly: true });

  // ---- Reverse the old legs — stock first, ledger second (T-166's "unwind before write" order,
  // mirrored for the giving-back direction: reversing every physical leg before touching the
  // books mirrors postUsageRecord/voidUsageRecord's own ordering discipline). ----------------
  for (const line of oldLines) {
    if (!line.movementId) continue;
    if (line.direction === 'out') {
      const result = await reverseConsumption(tx, {
        orgId: record.orgId, storeId: record.storeId, locationId: record.locationId, itemId: line.itemId,
        originalMovementId: line.movementId, quantity: quantity(line.quantity),
        movedAt: new Date(`${record.producedOn}T00:00:00Z`), kind: 'production_out',
        sourceType: 'production_edit_reversal', sourceId: line.id, createdBy: actor.personId,
      });
      if (!result.ok) throw new Error(`editPostedProduction: could not reverse input line ${line.id} — ${result.reason}`);
    } else {
      const given = await reverseOwnLayer(tx, {
        orgId: record.orgId, storeId: record.storeId, locationId: record.locationId, itemId: line.itemId,
        movementId: line.movementId, quantity: quantity(line.quantity), asOf: record.producedOn,
        sourceType: 'production_edit_reversal', sourceId: line.id, createdBy: actor.personId,
      });
      if (!given.ok) return given;
    }
  }
  await productionRepo.markLinesReversed(tx, oldLines.map((l) => l.id));

  // ---- Reverse the old journal entry (never for a would-be convert — excluded above). ---------
  if (record.journalEntryId) {
    await reverseEntry(tx, {
      entryId: record.journalEntryId,
      reason: `production record ${record.id} edited — revision ${record.revision} -> ${record.revision + 1}`,
      reversalDate: record.producedOn,
      reversedBy: actor.personId,
    });
  }

  // ---- Apply the new legs. ----------------------------------------------------------------
  const newRevision = record.revision + 1;

  // ⭐ Row FIRST, movement SECOND — same ordering `postProduction` uses, and for the same reason:
  // `stock_movements.source_id` is a plain uuid, and giving every line a real row id BEFORE
  // posting means `runProductionPosting` never has to fall back to the record id (which would
  // collide on `stock_movements_source_pair_key` if two lines named the same (item, location)).
  const newInputRows = await productionRepo.insertProductionRecordLines(
    tx, record.id, newRevision,
    input.inputs.map((l) => ({ direction: 'out' as const, itemId: l.itemId, quantity: l.quantity, unit: l.unit })),
  );
  const newOutputRows = await productionRepo.insertProductionRecordLines(
    tx, record.id, newRevision,
    input.outputs.map((l) => ({ direction: 'in' as const, itemId: l.itemId, quantity: l.quantity, unit: l.unit })),
  );

  const inputs = input.inputs.map((l, i) => ({ lineRowId: newInputRows[i]!.id, itemId: l.itemId, quantity: quantity(l.quantity), unit: l.unit }));
  const outputs = input.outputs.map((l, i) => ({ lineRowId: newOutputRows[i]!.id, itemId: l.itemId, quantity: quantity(l.quantity), unit: l.unit }));

  const result = await runProductionPosting(tx, {
    orgId: record.orgId, storeId: record.storeId, locationId: record.locationId, kind: record.kind,
    recordId: record.id, producedOn: record.producedOn,
    labourCost: (input.labourCost ?? record.labourCost) as Money,
    inputs, outputs, postedBy: actor.personId, idempotencySuffix: `rev${newRevision}`,
  });
  if (!result.ok) throw new Error(`editPostedProduction: new legs refused after old ones were reversed — ${result.reason}`);
  for (let i = 0; i < result.inputMovements.length; i++) {
    await productionRepo.setLineMovement(tx, newInputRows[i]!.id, result.inputMovements[i]!.movementId);
  }
  for (let i = 0; i < result.outputMovements.length; i++) {
    await productionRepo.setLineMovement(tx, newOutputRows[i]!.id, result.outputMovements[i]!.movementId);
  }

  await productionRepo.bumpProductionRevision(tx, record.id, newRevision, result.journalEntryId);

  return { ok: true, revision: newRevision, journalEntryId: result.journalEntryId };
}

/** Gives back a layer THIS record created — the inverse of `stockLayersRepo.createLayer`, never
 *  FIFO-planned (an edit/void must return the EXACT layer it made, not whichever the planner
 *  would pick). Refuses if some of the output has already moved on. */
async function reverseOwnLayer(
  tx: Tx,
  input: {
    orgId: string; storeId: string; locationId: string; itemId: string; movementId: string;
    quantity: Quantity; asOf: string; sourceType: string; sourceId: string; createdBy: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [layer] = await tx
    .select({ id: stockLayersTable.id, remaining: stockLayersTable.remainingQuantity })
    .from(stockLayersTable)
    .where(eq(stockLayersTable.movementId, input.movementId));
  if (!layer) {
    return { ok: false, reason: `no layer found for movement ${input.movementId} — cannot reverse this output` };
  }
  if (compareQuantity(quantity(layer.remaining), input.quantity) < 0) {
    return {
      ok: false,
      reason: `only ${layer.remaining} of this output remains on hand — the rest has already moved, so this line cannot be reversed`,
    };
  }
  await tx
    .update(stockLayersTable)
    .set({ remainingQuantity: drizzleSql`${stockLayersTable.remainingQuantity} - ${input.quantity}::numeric`, updatedAt: new Date() })
    .where(eq(stockLayersTable.id, layer.id));

  await stockLedgerRepo.insertMovement(tx, {
    orgId: input.orgId, storeId: input.storeId, locationId: input.locationId, itemId: input.itemId,
    movedAt: new Date(`${input.asOf}T00:00:00Z`), quantity: negate(input.quantity), kind: 'production_in',
    sourceType: input.sourceType, sourceId: input.sourceId, createdBy: input.createdBy,
  });
  return { ok: true };
}
function negate(q: Quantity): Quantity {
  return (q.startsWith('-') ? q.slice(1) : `-${q}`) as Quantity;
}

// -----------------------------------------------------------------------------------------
// Void — manager+ (`void_production`). Tolerant of a missing ledger leg (invariant 9): the
// reversal is reconstructed from the RECORD's own fields, and a missing entry is reported, never
// fabricated or a stuck record.
// -----------------------------------------------------------------------------------------
export type VoidOutcome =
  | { readonly ok: true; readonly ledgerGap: boolean; readonly ledgerGapReason: string | null }
  | { readonly ok: false; readonly reason: string };

export async function voidProduction(tx: Tx, actor: Actor, input: { recordId: string; reason: string }): Promise<VoidOutcome> {
  const record = await productionRepo.getProductionRecord(tx, input.recordId);
  if (!record) return { ok: false, reason: `production record ${input.recordId} does not exist` };
  await authorize(tx, actor, 'void_production', { storeId: record.storeId, orgId: record.orgId });

  if (record.status !== 'posted') return { ok: false, reason: `production record ${input.recordId} is ${record.status}, not posted` };
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'a void needs a reason' };

  const locked = await hasLiveSlicerPaymentCovering(tx, { orgId: record.orgId, storeId: record.storeId, producedOn: record.producedOn });
  if (locked) {
    return { ok: false, reason: 'a live slicer payment covers this date — voiding it now would leave labour expensed against output that no longer exists' };
  }

  const lines = await productionRepo.listProductionRecordLines(tx, record.id, { revision: record.revision, unreversedOnly: true });

  // ⭐ Invariant 9 — proceed even when a leg is missing, from the RECORD's own fields.
  for (const line of lines) {
    if (!line.movementId) continue; // a gap in the STOCK side too — proceed and report, never invent.
    if (line.direction === 'out') {
      // ⚠️ Same date as the output-side reversal below and the ledger reversal further down —
      // `record.producedOn`, not "today". Voiding has no separate `voidedOn` input in this pass
      // (out of time budget to thread one through the UI too — see the task report); using one
      // consistent date for every leg of a single void is the load-bearing half of that trade.
      const result = await reverseConsumption(tx, {
        orgId: record.orgId, storeId: record.storeId, locationId: record.locationId, itemId: line.itemId,
        originalMovementId: line.movementId, quantity: quantity(line.quantity),
        movedAt: new Date(`${record.producedOn}T00:00:00Z`), kind: 'production_out',
        sourceType: 'production_void', sourceId: line.id, createdBy: actor.personId,
      });
      if (!result.ok) throw new Error(`voidProduction: could not reverse input line ${line.id} — ${result.reason}`);
    } else {
      const given = await reverseOwnLayer(tx, {
        orgId: record.orgId, storeId: record.storeId, locationId: record.locationId, itemId: line.itemId,
        movementId: line.movementId, quantity: quantity(line.quantity), asOf: record.producedOn,
        sourceType: 'production_void', sourceId: line.id, createdBy: actor.personId,
      });
      if (!given.ok) return given;
    }
  }
  await productionRepo.markLinesReversed(tx, lines.map((l) => l.id));

  let ledgerGap = false;
  let ledgerGapReason: string | null = null;
  if (record.journalEntryId) {
    try {
      const entry = await journalRepo.findEntryById(tx, record.journalEntryId);
      if (!entry) {
        ledgerGap = true;
        ledgerGapReason = `journal entry ${record.journalEntryId} no longer exists`;
      } else {
        await reverseEntry(tx, { entryId: record.journalEntryId, reason, reversalDate: record.producedOn, reversedBy: actor.personId });
      }
    } catch (err) {
      // ⭐ Invariant 9 — but narrowly: ONLY "the leg I expected is not there for me to reverse"
      // (already reversed by something else, or otherwise unreachable as a reversal target) is
      // tolerated here. A closed-period or frozen-location refusal is a DIFFERENT rule — invariant
      // 12 — and must still BLOCK the void, exactly as it blocks post and edit; swallowing that
      // one too would make void the one operation period locks cannot reach. `journal_entries`/
      // `journal_lines` are immutable once posted (a DB trigger refuses UPDATE/DELETE, T-105), so
      // in THIS schema "the row itself vanished" cannot happen post-FK — "already reversed" is
      // the reachable shape of "not there for me" that survives.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already reversed|does not exist/.test(message)) throw err;
      ledgerGap = true;
      ledgerGapReason = message;
    }
  }

  await productionRepo.markProductionVoid(tx, record.id, actor.personId, reason);

  return { ok: true, ledgerGap, ledgerGapReason };
}
