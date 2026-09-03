/**
 * FIFO layers — the SQL. T-162's storage half.
 *
 * ⭐ The decisions live in `packages/domain/src/stock/layers.ts` (pure, unit-tested without a
 * database); this file only reads rows for that planner and writes what it decided. The same split
 * `expenses/routing.ts` already uses, and the reason the FIFO arithmetic could be tested before a
 * table existed.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { stockLayerConsumptions, stockLayers } from '../../schema/stock-layers';
import type { Tx } from '../client';

export interface CreateLayerInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly itemId: string;
  readonly receivedAt: Date;
  readonly quantity: string;
  readonly unitCost: string;
  readonly source: (typeof stockLayers.source)['_']['data'];
  readonly sourceId: string;
  readonly movementId: string;
  readonly invoiceLineId?: string | null;
}

export async function createLayer(tx: Tx, input: CreateLayerInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(stockLayers)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      itemId: input.itemId,
      receivedAt: input.receivedAt,
      quantity: input.quantity,
      unitCost: input.unitCost,
      // A new layer is wholly unconsumed. The tie-trigger checks this against its (empty) subledger.
      remainingQuantity: input.quantity,
      source: input.source,
      sourceId: input.sourceId,
      movementId: input.movementId,
      isProvisional: input.invoiceLineId == null,
      invoiceLineId: input.invoiceLineId ?? null,
    })
    .returning({ id: stockLayers.id });
  return row!;
}

/**
 * Open layers for an item in a store, oldest first — the planner's input.
 *
 * ⭐ **`FOR UPDATE`.** Two consumers of the same item must not both read the same remaining
 * quantities and both commit; this is the layer-side twin of `onHandForUpdate`, and the reason
 * v1's −20 kg drift cannot recur here.
 */
export async function openLayersForUpdate(
  tx: Tx,
  itemId: string,
  storeId: string,
): Promise<{ id: string; receivedAt: Date; remainingQuantity: string; unitCost: string }[]> {
  return tx
    .select({
      id: stockLayers.id,
      receivedAt: stockLayers.receivedAt,
      remainingQuantity: stockLayers.remainingQuantity,
      unitCost: stockLayers.unitCost,
    })
    .from(stockLayers)
    .where(
      and(
        eq(stockLayers.itemId, itemId),
        eq(stockLayers.storeId, storeId),
        gt(stockLayers.remainingQuantity, '0'),
      ),
    )
    .orderBy(asc(stockLayers.receivedAt), asc(stockLayers.id))
    .for('update');
}

/** Apply one planned consumption line: write the subledger row and decrement its layer. */
export async function applyConsumption(
  tx: Tx,
  input: {
    orgId: string;
    layerId: string;
    movementId: string;
    quantity: string;
    unitCost: string;
    cost: string;
  },
): Promise<void> {
  await tx.insert(stockLayerConsumptions).values({
    orgId: input.orgId,
    layerId: input.layerId,
    movementId: input.movementId,
    quantity: input.quantity,
    unitCost: input.unitCost,
    cost: input.cost,
  });
  await tx
    .update(stockLayers)
    .set({
      remainingQuantity: sql`${stockLayers.remainingQuantity} - ${input.quantity}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(stockLayers.id, input.layerId));
}

/**
 * What a movement's consumption still owes back — the rows T-179's partial return walks.
 *
 * ⚠️ **Outstanding, not original.** `planReversal` reverses the newest layer consumed first, so a
 * second partial return must be handed what is LEFT, or both plans take from the same layer and
 * the totals double. That contract is on `planReversal` itself; this is the query that satisfies it.
 */
export async function outstandingConsumptions(
  tx: Tx,
  movementId: string,
): Promise<{ id: string; layerId: string; quantity: string; unitCost: string; cost: string }[]> {
  return tx
    .select({
      id: stockLayerConsumptions.id,
      layerId: stockLayerConsumptions.layerId,
      quantity: stockLayerConsumptions.quantity,
      unitCost: stockLayerConsumptions.unitCost,
      cost: stockLayerConsumptions.cost,
    })
    .from(stockLayerConsumptions)
    .where(
      and(
        eq(stockLayerConsumptions.movementId, movementId),
        sql`${stockLayerConsumptions.reversedByMovementId} is null`,
      ),
    )
    .orderBy(asc(stockLayerConsumptions.createdAt), asc(stockLayerConsumptions.id));
}

/**
 * Give a consumption back to the layer it came from — a void, or a customer return.
 *
 * ⭐ **T-179/DEF-128.** `quantity` is REQUIRED, not derived from the row — `planReversal`
 * (`domain/src/stock/layers.ts`) can ask for LESS than a row's full amount (the last layer a
 * partial return touches is rarely consumed exactly to the edge). ⚠️ **Found live**: this
 * function used to ignore the plan's own `give` and always reverse a row's FULL quantity —
 * silently wrong the moment two sequential partial returns crossed one row, cured only by luck
 * whenever a return happened to reverse whole rows. A row is never mutated to "become smaller" —
 * `unit_cost` is a fact and stays exactly attached to its own row (invariant 5) — so a partial
 * take SPLITS: the original row shrinks to what is STILL outstanding, and a new row, already
 * reversed, carries exactly the amount given back.
 */
export async function reverseConsumption(
  tx: Tx,
  consumptionId: string,
  quantity: string,
  reversedByMovementId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      orgId: stockLayerConsumptions.orgId, layerId: stockLayerConsumptions.layerId,
      movementId: stockLayerConsumptions.movementId, quantity: stockLayerConsumptions.quantity,
      unitCost: stockLayerConsumptions.unitCost, cost: stockLayerConsumptions.cost,
    })
    .from(stockLayerConsumptions)
    .where(eq(stockLayerConsumptions.id, consumptionId));
  if (!row) throw new Error(`consumption ${consumptionId} not found`);
  if (Number(quantity) > Number(row.quantity) + 0.0005) {
    throw new Error(`reverseConsumption: row ${consumptionId} only has ${row.quantity} outstanding, ${quantity} requested`);
  }

  const reversedCost = (Number(quantity) * Number(row.unitCost)).toFixed(2);

  if (Number(quantity) >= Number(row.quantity) - 0.0005) {
    // The whole row — no split needed.
    await tx
      .update(stockLayerConsumptions)
      .set({ reversedByMovementId })
      .where(eq(stockLayerConsumptions.id, consumptionId));
  } else {
    // ⭐ Partial — the original row shrinks to what remains outstanding (never touching
    // unit_cost, the fact §5 requires stays fixed); a new, already-reversed row carries exactly
    // the amount given back, against the SAME original movement.
    const remainingQuantity = (Number(row.quantity) - Number(quantity)).toFixed(3);
    const remainingCost = (Number(row.cost) - Number(reversedCost)).toFixed(2);
    await tx
      .update(stockLayerConsumptions)
      .set({ quantity: remainingQuantity, cost: remainingCost })
      .where(eq(stockLayerConsumptions.id, consumptionId));
    await tx.insert(stockLayerConsumptions).values({
      orgId: row.orgId, layerId: row.layerId, movementId: row.movementId,
      quantity, unitCost: row.unitCost, cost: reversedCost, reversedByMovementId,
    });
  }

  // ⭐ Back to the layer it actually came from — never to the oldest open layer, which would be a
  // silent re-costing (T-162 invariant 7).
  await tx
    .update(stockLayers)
    .set({
      remainingQuantity: sql`${stockLayers.remainingQuantity} + ${quantity}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(stockLayers.id, row.layerId));
}

/**
 * ⭐ T-170's `credit_basis` derivation. A delivery's layers are tagged `source='delivery',
 * sourceId=deliveryId` at receipt (one per line — see `deliveries/receive.ts`), so this is the
 * one query that answers "does the receipt this item came from carry a linked supplier invoice?"
 * — `isProvisional` is false exactly when `invoiceLineId` is set (the schema's own CHECK).
 *
 * Returns the layer regardless of `remainingQuantity` — a fully-consumed layer's invoice status
 * still answers the question; only the COST a return relieves comes from wherever stock actually
 * is now (T-162 invariant 4), never from this row.
 */
export async function findByDeliveryItem(
  tx: Tx,
  deliveryId: string,
  itemId: string,
): Promise<{ id: string; isProvisional: boolean } | undefined> {
  const [row] = await tx
    .select({ id: stockLayers.id, isProvisional: stockLayers.isProvisional })
    .from(stockLayers)
    .where(and(eq(stockLayers.source, 'delivery'), eq(stockLayers.sourceId, deliveryId), eq(stockLayers.itemId, itemId)));
  return row;
}

/**
 * ⭐ Σ (remaining × unit cost) — the number Phase 3's exit gate compares against the inventory
 * control account. Derived on every read; there is no stored valuation to go stale.
 */
export async function valuation(
  tx: Tx,
  storeId?: string,
): Promise<{ itemId: string; quantity: string; value: string }[]> {
  const where = storeId
    ? and(gt(stockLayers.remainingQuantity, '0'), eq(stockLayers.storeId, storeId))
    : gt(stockLayers.remainingQuantity, '0');

  return tx
    .select({
      itemId: stockLayers.itemId,
      quantity: sql<string>`sum(${stockLayers.remainingQuantity})::text`,
      value: sql<string>`round(sum(${stockLayers.remainingQuantity} * ${stockLayers.unitCost}), 2)::text`,
    })
    .from(stockLayers)
    .where(where)
    .groupBy(stockLayers.itemId)
    .orderBy(asc(stockLayers.itemId));
}
