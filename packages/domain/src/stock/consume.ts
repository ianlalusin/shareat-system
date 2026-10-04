/**
 * The transactional consumer — T-162's second half, deferred until it had a caller.
 *
 * ⭐ **It was right to wait.** T-162 stopped at the pure planner and the repo primitives, because
 * *"the wrapper's real shape depends on its first caller, and inventing a signature ahead of one
 * is how it ends up fitting nothing."* T-168's usage post is that caller, and the shape it needed
 * — take a quantity, give back cost lines and a movement, inside a transaction the caller owns —
 * is not the one that would have been guessed.
 *
 * ## What one call does
 *
 * ```
 * 1. lock the item's open layers          FOR UPDATE  (v1's −20 kg drift cannot recur)
 * 2. plan the consumption                 pure        (planConsumption, oldest first)
 * 3. write the OUT movement               T-161
 * 4. apply each layer line                T-162       subledger row + layer decrement
 * ```
 *
 * ⚠️ **The lock comes first, before the plan.** Planning against unlocked layers and then writing
 * is exactly v1's shape: two posters read the same remaining quantities and both commit. The lock
 * is what makes the plan still true by the time it is applied.
 */
import { decimal, money, type Money } from '@shareat/core/money';
import { stockLayersRepo, stockLedgerRepo, type Tx } from '@shareat/db';
import { planConsumption, planReversal, type ConsumedLine, type CostLayer } from './layers';
import { fromThousandths, quantity, toThousandths, type Quantity } from './quantity';
import type { StockMovementKind } from '@shareat/db/schema';

export interface ConsumeInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly itemId: string;
  /** Positive, in base units. The direction is the `kind`, never the sign. */
  readonly quantity: Quantity;
  readonly movedAt: Date;
  readonly kind: StockMovementKind;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly createdBy: string;
}

export interface ConsumeResult {
  readonly ok: true;
  readonly movementId: string;
  readonly lines: readonly ConsumedLine[];
  readonly totalCost: Money;
}

export type ConsumeOutcome = ConsumeResult | { readonly ok: false; readonly reason: string };

/**
 * Consume stock: relieve the oldest layers, write the movement, record the subledger.
 *
 * ⛔ **A shortfall is refused and nothing is written** — no negative layer, no "vacuum"
 * correction. Odoo solves that case with a whole subsystem; discovery 20 recommended refusing it
 * instead, and this is where that refusal lives.
 */
export async function consume(tx: Tx, input: ConsumeInput): Promise<ConsumeOutcome> {
  // 1. Lock first. Everything below is only true because of this line.
  const open = await stockLayersRepo.openLayersForUpdate(tx, input.itemId, input.storeId);
  const layers: CostLayer[] = open.map((l) => ({
    id: l.id,
    receivedAt: l.receivedAt,
    remainingQuantity: quantity(l.remainingQuantity),
    unitCost: decimal(l.unitCost, '14,4'), // T-371 R4: re-minted at the column's shape before it is re-written
  }));

  // 2. Plan — pure, and separately unit-tested without a database.
  const plan = planConsumption(layers, input.quantity);
  if (!plan.ok) return plan;

  // 3. The OUT movement. ⚠️ Negative: the ledger is signed, and the sign is applied here rather
  //    than asked of every caller.
  const movement = await stockLedgerRepo.insertMovement(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    locationId: input.locationId,
    itemId: input.itemId,
    movedAt: input.movedAt,
    quantity: negate(input.quantity),
    kind: input.kind,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    createdBy: input.createdBy,
  });

  // 4. Apply. The deferred tie-trigger checks at COMMIT that the layers and the subledger agree.
  for (const line of plan.lines) {
    await stockLayersRepo.applyConsumption(tx, {
      orgId: input.orgId,
      layerId: line.layerId,
      movementId: movement.id,
      quantity: line.quantity,
      unitCost: decimal(line.unitCost, '14,4'),
      cost: line.cost,
    });
  }

  return { ok: true, movementId: movement.id, lines: plan.lines, totalCost: plan.totalCost };
}

/**
 * Give consumed stock back — a void, or a customer return (T-179).
 *
 * ⭐ **The outstanding rows are read, not the original ones**, which is the contract `planReversal`
 * carries and which a failing test found the hard way: two partial reversals built from the same
 * full list both take from the newest layer and double-count.
 */
export async function reverseConsumption(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    locationId: string;
    itemId: string;
    /** The movement being given back. */
    originalMovementId: string;
    quantity: Quantity;
    movedAt: Date;
    kind: StockMovementKind;
    sourceType: string;
    sourceId: string;
    createdBy: string;
  },
): Promise<ConsumeOutcome> {
  const outstanding = await stockLayersRepo.outstandingConsumptions(tx, input.originalMovementId);
  const consumed: ConsumedLine[] = outstanding.map((c) => ({
    layerId: c.layerId,
    quantity: quantity(c.quantity),
    unitCost: decimal(c.unitCost, '14,4'),
    cost: money(c.cost), // T-371 R4: a database value is re-minted, never cast
  }));

  const plan = planReversal(consumed, input.quantity);
  if (!plan.ok) return plan;

  const movement = await stockLedgerRepo.insertMovement(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    locationId: input.locationId,
    itemId: input.itemId,
    movedAt: input.movedAt,
    quantity: input.quantity,
    kind: input.kind,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    createdBy: input.createdBy,
  });

  // ⭐ Back to the exact layers it came from, never to the oldest open one — a void that re-FIFOs
  // is a silent re-costing (T-162 invariant 7).
  for (const line of plan.lines) {
    const row = outstanding.find((c) => c.layerId === line.layerId);
    if (!row) return { ok: false, reason: `no outstanding consumption for layer ${line.layerId}` };
    await stockLayersRepo.reverseConsumption(tx, row.id, line.quantity, movement.id);
  }

  return { ok: true, movementId: movement.id, lines: plan.lines, totalCost: plan.totalCost };
}

/** T-371 G3: negated in scaled bigint and minted by the one mint, never a string flip cast to the brand. */
function negate(q: Quantity): Quantity {
  return fromThousandths(-toThousandths(q));
}
