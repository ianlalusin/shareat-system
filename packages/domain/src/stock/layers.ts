/**
 * FIFO cost layers — the pure half. T-162 §4.
 *
 * ⭐ **This is the rule the whole of Phase 3 rests on.** Every posting T-163 and T-164 make is a
 * consequence of what these two functions return: what a consumption costs, and what a reversal
 * gives back. Nothing here touches the database, so the arithmetic is testable on its own — the
 * same split `expenses/routing.ts` already uses (a pure decision function, called from a thin
 * service that does the write).
 *
 * FIFO is bible row 110, decided ahead of the research pass on physical grounds: food is
 * perishable and actually moves first-in-first-out, so FIFO tracks reality rather than
 * approximating it. ADR-009 §1 then found that **a delivery already IS a cost layer** — quantity,
 * unit cost, one receipt — so this maps v1's shape rather than replacing it.
 *
 * ## Two decisions in here that a reader would otherwise have to re-derive
 *
 * ⭐ **1. Cost is rounded PER LINE, never on the total.** Each line becomes a real
 * `stock_layer_consumptions` row — the inventory subledger — and the journal entry must equal the
 * sum of those rows or invariant 6's inventory arm breaks. Rounding the total instead would put
 * the entry a centavo away from its own detail, which is exactly the class of drift this project
 * exists to remove. Three lines of 1 unit at ₱0.0050 cost ₱0.03, not ₱0.02.
 *
 * ⭐ **2. A reversal walks the consumption BACKWARDS.** T-162 invariant 7 says quantity returns to
 * the exact layers it came from; for a *partial* return (T-179 §5) the order has to be chosen, and
 * it is newest-consumed-first. That makes a sequence of partial returns sum to exactly the full
 * reversal, and it is the direction the reversal already runs in — one rule in the system, not
 * two. ⛔ It never re-costs at a current rate: nothing in the input carries one, deliberately, so
 * a caller cannot pass one by accident.
 *
 * ⛔ **What is NOT here, per T-162 §7:** no GL posting (T-163/T-164 own the journal), no negative
 * layers, no "vacuum" correction, no backdated re-costing engine. A shortfall is REFUSED — the
 * case Odoo solves with a whole subsystem, and refusing it is the deliberate simplification
 * discovery 20 recommended.
 */
import { add, fromCentavos, ZERO, type Money } from '@shareat/core/money';
import {
  addQuantity,
  compareQuantity,
  isPositiveQuantity,
  quantity,
  subtractQuantity,
  toThousandths,
  type Quantity,
} from './quantity';

/** An open cost layer — the fields FIFO reads. One row per receipt of an item into a store. */
export interface CostLayer {
  readonly id: string;
  /** The FIFO ordering key. ISO string or Date; ties break by `id` so the order is total. */
  readonly receivedAt: string | Date;
  readonly remainingQuantity: Quantity;
  /** Landed cost per BASE unit, `numeric(14,4)` as a decimal string. */
  readonly unitCost: string;
}

/**
 * One layer's share of a consumption — and the shape a `stock_layer_consumptions` row takes.
 *
 * ⚠️ `unitCost` is snapshotted here rather than looked up later. T-145's header already drew the
 * line and it holds: *a balance is a consequence of facts and must be recomputed, but a cost used
 * in a past transaction **is** a fact.* Re-costing a layer next year must not rewrite what a March
 * COGS posting said.
 */
export interface ConsumedLine {
  readonly layerId: string;
  readonly quantity: Quantity;
  readonly unitCost: string;
  readonly cost: Money;
}

export interface ConsumptionPlan {
  readonly ok: true;
  readonly lines: readonly ConsumedLine[];
  readonly totalCost: Money;
}

/**
 * Never throws; every rejection is a named `{ ok: false, reason }` — the same discipline
 * `routeExpense` and `legacy-adapter`'s `AdaptResult` already use, so a caller decides what to do
 * with a refusal rather than catching.
 */
export interface PlanRefused {
  readonly ok: false;
  readonly reason: string;
}

export type ConsumptionResult = ConsumptionPlan | PlanRefused;

/** `numeric(14,4)` — a rate, per bible §6. */
const UNIT_COST_PATTERN = /^-?\d+(\.\d{1,4})?$/;

/**
 * Plan a consumption of `wanted` base units against the open layers, oldest first.
 *
 * Pure: the layers are read, never mutated, and the same inputs always give the same plan.
 */
export function planConsumption(
  layers: readonly CostLayer[],
  wanted: Quantity,
): ConsumptionResult {
  if (!isPositiveQuantity(wanted)) {
    return { ok: false, reason: `a consumption must be positive, got ${wanted}` };
  }

  const open = sortForFifo(layers).filter((l) => isPositiveQuantity(l.remainingQuantity));
  const available = open.reduce((sum, l) => addQuantity(sum, l.remainingQuantity), quantity('0'));

  if (compareQuantity(available, wanted) < 0) {
    // ⛔ Refused, never absorbed. There is no negative layer and no vacuum correction (§7).
    return {
      ok: false,
      reason: `only ${available} available, ${wanted} requested — a shortfall is refused, not absorbed`,
    };
  }

  const lines: ConsumedLine[] = [];
  let outstanding = wanted;

  for (const layer of open) {
    if (!isPositiveQuantity(outstanding)) break;

    const take =
      compareQuantity(layer.remainingQuantity, outstanding) <= 0
        ? layer.remainingQuantity
        : outstanding;

    lines.push(consumedLine(layer.id, take, layer.unitCost));
    outstanding = subtractQuantity(outstanding, take);
  }

  return { ok: true, lines, totalCost: add(...lines.map((l) => l.cost), ZERO) };
}

/**
 * Plan the reversal of `wanted` base units of an existing consumption — a void, or a customer
 * return (T-179).
 *
 * ⭐ Walks `consumed` backwards, so the last layer taken from is the first given back.
 *
 * ⚠️ **`consumed` is what is STILL OUTSTANDING, not the original sale.** For a second partial
 * return the caller subtracts what the first one already gave back and passes the remainder. This
 * function cannot do that itself — it never sees prior reversals — and getting it wrong
 * double-counts: two plans built from the same full list both take from the newest layer.
 *
 * ⭐ **Found by the test, not by review.** The first draft of `fifo-rules.test.ts` asserted that
 * two independent partial plans sum to the full reversal; they do not, and the failing number
 * (₱1,700 against ₱1,600) is what surfaced the contract. **The transactional caller in
 * `consume.ts` must derive the outstanding rows from `stock_layer_consumptions` minus prior
 * reversals** — recorded here so that requirement reaches T-162's second half rather than being
 * re-derived from a bug.
 */
export function planReversal(
  consumed: readonly ConsumedLine[],
  wanted: Quantity,
): ConsumptionResult {
  if (!isPositiveQuantity(wanted)) {
    return { ok: false, reason: `a reversal must be positive, got ${wanted}` };
  }

  const total = consumed.reduce((sum, l) => addQuantity(sum, l.quantity), quantity('0'));
  if (compareQuantity(total, wanted) < 0) {
    return {
      ok: false,
      reason: `only ${total} was consumed, ${wanted} requested — a reversal cannot exceed it`,
    };
  }

  const lines: ConsumedLine[] = [];
  let outstanding = wanted;

  for (const line of [...consumed].reverse()) {
    if (!isPositiveQuantity(outstanding)) break;

    const give = compareQuantity(line.quantity, outstanding) <= 0 ? line.quantity : outstanding;

    // ⛔ The cost is the one the consumption snapshotted — never a current rate, which is why no
    // current rate is reachable from this function's inputs.
    lines.push(consumedLine(line.layerId, give, line.unitCost));
    outstanding = subtractQuantity(outstanding, give);
  }

  return { ok: true, lines, totalCost: add(...lines.map((l) => l.cost), ZERO) };
}

function consumedLine(layerId: string, qty: Quantity, unitCost: string): ConsumedLine {
  return { layerId, quantity: qty, unitCost, cost: lineCost(qty, unitCost) };
}

/**
 * quantity(3dp) x unitCost(4dp) -> Money(2dp), rounded half-up at the centavo.
 *
 * ⭐ **Exported because T-166's receiving needs exactly this**, and a second implementation of
 * "quantity times a rate" is how two parts of one system come to disagree about what a delivery
 * cost. ⚠️ `unitCost` is a RATE at `numeric(14,4)`, so it cannot go through `money()` — that
 * rejects anything past 2dp, which is the bug this export replaced.
 *
 * Computed in integers throughout: thousandths x ten-thousandths gives a 10^7 scale, divided down
 * to centavos in one step. ⚠️ **One rounding, at the end of the line** — never an intermediate one,
 * which is the compounding error bible §12 landmine 25 names.
 */
export function lineCost(qty: Quantity, unitCost: string): Money {
  const trimmed = unitCost.trim();
  if (!UNIT_COST_PATTERN.test(trimmed)) {
    throw new TypeError(`Invalid unit cost: ${JSON.stringify(unitCost)} (expected numeric(14,4))`);
  }
  const negative = trimmed.startsWith('-');
  const [whole, frac = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const rate = BigInt(whole ?? '0') * 10_000n + BigInt(frac.padEnd(4, '0'));

  // thousandths (10^3) x ten-thousandths (10^4) = 10^7; centavos are 10^2, so divide by 10^5.
  const product = toThousandths(qty) * (negative ? -rate : rate);
  return fromCentavos(divideRoundHalfUp(product, 100_000n));
}

/** Half-up on the absolute value, sign restored — matching `money.ts`'s own rounding. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Oldest `receivedAt` first, ties broken by `id` so the order is total and reproducible. */
function sortForFifo(layers: readonly CostLayer[]): CostLayer[] {
  return [...layers].sort((a, b) => {
    const at = new Date(a.receivedAt).getTime();
    const bt = new Date(b.receivedAt).getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The type a caller works in, re-exported so it need not reach past this module for it.
 *  ⚠️ The *constructors* are deliberately NOT re-exported — `money` belongs to `@shareat/core` and
 *  `quantity` to `./quantity`, and a second import path for either is a second place to look. */
export type { Quantity };
