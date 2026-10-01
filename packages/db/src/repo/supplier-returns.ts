/**
 * Supplier returns' SQL — T-170. The domain module (`packages/domain/src/stock/supplier-returns.ts`)
 * owns the rules; this file only reads rows and writes what the domain decided.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  supplierReturnLines,
  supplierReturns,
  type CreditBasis,
  type SupplierReturnStatus,
} from '../../schema/supplier-returns';
import { stockLocations } from '../../schema/stock-locations';
import type { Tx } from '../client';

/**
 * ⭐ `stock_movements`/`stock_locations` carry no composite FK tying a location to a store (T-167's
 * `stock_transfers` added one for exactly this reason; this table did not need to until now) —
 * so a return's own location is checked explicitly rather than trusted to a constraint that does
 * not exist.
 */
export async function locationBelongsToStore(tx: Tx, locationId: string, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(and(eq(stockLocations.id, locationId), eq(stockLocations.storeId, storeId)));
  return row !== undefined;
}

/**
 * Mint the id the new return WILL have, before inserting it — same reason
 * `attendance-adjustments.ts`'s `nextAdjustmentId` does: the journal entry that must reference
 * this return (`sourceId`) has to be postable BEFORE the row exists, so the id is minted first
 * and both the entry and the row are created with it already fixed. Postgres mints it, so id
 * generation stays time-ordered (uuidv7) rather than falling back to a non-chronological
 * `crypto.randomUUID()`.
 */
export async function nextReturnId(tx: Tx): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
  return String((r as unknown as { id: string }[])[0]!.id);
}

export interface ReturnLineInput {
  readonly lineNo: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: string;
  readonly deliveryLineId: string | null;
  readonly movementId: string;
  readonly unitCost: string;
  readonly creditBasis: 'grni' | 'supplier_advance';
}

export interface CreateReturnInput {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly supplierId: string;
  readonly deliveryId: string | null;
  readonly returnedOn: string;
  readonly reason: string;
  readonly creditBasis: CreditBasis;
  readonly journalEntryId: string;
  readonly createdBy: string;
  readonly lines: readonly ReturnLineInput[];
}

export async function createReturn(tx: Tx, input: CreateReturnInput): Promise<{ id: string }> {
  await tx.insert(supplierReturns).values({
    id: input.id,
    orgId: input.orgId,
    storeId: input.storeId,
    supplierId: input.supplierId,
    deliveryId: input.deliveryId,
    returnedOn: input.returnedOn,
    reason: input.reason,
    creditBasis: input.creditBasis,
    journalEntryId: input.journalEntryId,
    createdBy: input.createdBy,
  });

  for (const line of input.lines) {
    await tx.insert(supplierReturnLines).values({
      returnId: input.id,
      lineNo: line.lineNo,
      itemId: line.itemId,
      locationId: line.locationId,
      quantity: line.quantity,
      deliveryLineId: line.deliveryLineId,
      movementId: line.movementId,
      unitCost: line.unitCost,
      creditBasis: line.creditBasis,
    });
  }

  return { id: input.id };
}

export interface SupplierReturnRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly supplierId: string;
  readonly deliveryId: string | null;
  readonly status: SupplierReturnStatus;
  readonly journalEntryId: string;
  /** The return's own date - the reversal of a void is dated by it, so a closed month has to refuse it. */
  readonly returnedOn: string;
}

export async function getReturn(tx: Tx, id: string): Promise<SupplierReturnRow | undefined> {
  const [row] = await tx
    .select({
      id: supplierReturns.id,
      orgId: supplierReturns.orgId,
      storeId: supplierReturns.storeId,
      supplierId: supplierReturns.supplierId,
      deliveryId: supplierReturns.deliveryId,
      status: supplierReturns.status,
      journalEntryId: supplierReturns.journalEntryId,
      returnedOn: supplierReturns.returnedOn,
    })
    .from(supplierReturns)
    .where(eq(supplierReturns.id, id));
  return row as SupplierReturnRow | undefined;
}

export interface ReturnLineRow {
  readonly id: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: string;
  readonly deliveryLineId: string | null;
  readonly movementId: string;
  readonly unitCost: string;
  readonly creditBasis: 'grni' | 'supplier_advance';
}

export async function getReturnLines(tx: Tx, returnId: string): Promise<ReturnLineRow[]> {
  return tx
    .select({
      id: supplierReturnLines.id,
      itemId: supplierReturnLines.itemId,
      locationId: supplierReturnLines.locationId,
      quantity: supplierReturnLines.quantity,
      deliveryLineId: supplierReturnLines.deliveryLineId,
      movementId: supplierReturnLines.movementId,
      unitCost: supplierReturnLines.unitCost,
      creditBasis: supplierReturnLines.creditBasis,
    })
    .from(supplierReturnLines)
    .where(eq(supplierReturnLines.returnId, returnId));
}

/** Σ already-returned quantity for a delivery line, across every POSTED return — invariant 2's cap. */
export async function returnedQuantityForDeliveryLine(tx: Tx, deliveryLineId: string): Promise<string> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${supplierReturnLines.quantity}), 0)::text` })
    .from(supplierReturnLines)
    .innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId))
    .where(and(eq(supplierReturnLines.deliveryLineId, deliveryLineId), eq(supplierReturns.status, 'posted')));
  return row?.total ?? '0';
}

export async function markVoid(tx: Tx, id: string, voidedBy: string, reason: string, at: Date): Promise<void> {
  await tx
    .update(supplierReturns)
    .set({ status: 'void', voidedAt: at, voidedBy, voidReason: reason })
    .where(eq(supplierReturns.id, id));
}
