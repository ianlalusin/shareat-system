/**
 * Stock transfers' SQL — T-167. The domain module (`packages/domain/src/stock/transfers.ts`)
 * owns the rules; this file only reads rows and writes what the domain decided.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  stockReservations,
  stockTransferLines,
  stockTransfers,
  type TransferMode,
  type TransferStatus,
} from '../../schema/stock-transfers';
import type { Tx } from '../client';

export interface TransferLineInput {
  readonly lineNo: string;
  readonly itemId: string;
  readonly quantity: string;
}

export interface CreateTransferInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly mode: TransferMode;
  readonly status: TransferStatus;
  readonly note?: string | null;
  readonly createdBy: string;
  readonly lines: readonly TransferLineInput[];
  /**
   * ⭐ `transferNow` only. The header's shape checks require `dispatched_at`/`received_at` to be
   * set the MOMENT `status` says `received` — there is no valid intermediate row a separate
   * UPDATE could pass through. So the immediate case sets everything in this one INSERT rather
   * than create-then-update.
   */
  readonly dispatchedAt?: Date;
  readonly dispatchedBy?: string;
  readonly receivedAt?: Date;
  readonly receivedBy?: string;
}

export interface TransferRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly mode: TransferMode;
  readonly status: TransferStatus;
}

export interface TransferLineRow {
  readonly id: string;
  readonly transferId: string;
  readonly lineNo: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly outMovementId: string | null;
  readonly inMovementId: string | null;
}

export async function createTransfer(
  tx: Tx,
  input: CreateTransferInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(stockTransfers)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      mode: input.mode,
      status: input.status,
      dispatchedAt: input.dispatchedAt ?? null,
      dispatchedBy: input.dispatchedBy ?? null,
      receivedAt: input.receivedAt ?? null,
      receivedBy: input.receivedBy ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning({ id: stockTransfers.id });
  const transfer = row!;

  for (const line of input.lines) {
    await tx.insert(stockTransferLines).values({
      transferId: transfer.id,
      lineNo: line.lineNo,
      itemId: line.itemId,
      quantity: line.quantity,
    });
  }

  return transfer;
}

export async function getTransfer(tx: Tx, id: string): Promise<TransferRow | undefined> {
  const [row] = await tx
    .select({
      id: stockTransfers.id,
      orgId: stockTransfers.orgId,
      storeId: stockTransfers.storeId,
      fromLocationId: stockTransfers.fromLocationId,
      toLocationId: stockTransfers.toLocationId,
      mode: stockTransfers.mode,
      status: stockTransfers.status,
    })
    .from(stockTransfers)
    .where(eq(stockTransfers.id, id));
  return row as TransferRow | undefined;
}

export async function getTransferLines(tx: Tx, transferId: string): Promise<TransferLineRow[]> {
  return tx
    .select({
      id: stockTransferLines.id,
      transferId: stockTransferLines.transferId,
      lineNo: stockTransferLines.lineNo,
      itemId: stockTransferLines.itemId,
      quantity: stockTransferLines.quantity,
      outMovementId: stockTransferLines.outMovementId,
      inMovementId: stockTransferLines.inMovementId,
    })
    .from(stockTransferLines)
    .where(eq(stockTransferLines.transferId, transferId));
}

export async function setLineOutMovement(tx: Tx, lineId: string, movementId: string): Promise<void> {
  await tx.update(stockTransferLines).set({ outMovementId: movementId }).where(eq(stockTransferLines.id, lineId));
}

export async function setLineInMovement(tx: Tx, lineId: string, movementId: string): Promise<void> {
  await tx.update(stockTransferLines).set({ inMovementId: movementId }).where(eq(stockTransferLines.id, lineId));
}

export async function markDispatched(tx: Tx, id: string, dispatchedBy: string, at: Date): Promise<void> {
  await tx
    .update(stockTransfers)
    .set({ status: 'in_transit', dispatchedAt: at, dispatchedBy })
    .where(eq(stockTransfers.id, id));
}

export async function markReceived(tx: Tx, id: string, receivedBy: string, at: Date): Promise<void> {
  await tx
    .update(stockTransfers)
    .set({ status: 'received', receivedAt: at, receivedBy })
    .where(eq(stockTransfers.id, id));
}

export async function markVoid(tx: Tx, id: string, voidedBy: string, reason: string, at: Date): Promise<void> {
  await tx
    .update(stockTransfers)
    .set({ status: 'void', voidedAt: at, voidedBy, voidReason: reason })
    .where(eq(stockTransfers.id, id));
}

export interface CreateReservationInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly transferId: string;
}

export async function createReservation(tx: Tx, input: CreateReservationInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(stockReservations)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      itemId: input.itemId,
      quantity: input.quantity,
      transferId: input.transferId,
    })
    .returning({ id: stockReservations.id });
  return row!;
}

/**
 * ⭐ Set exactly once. A second call affects zero rows rather than erroring — the caller reads
 * `released` to know which happened. This is invariant 5's "void must not double-release a
 * reservation already resolved by receive," implemented as a conditional UPDATE rather than a
 * check the caller has to remember to make first.
 */
export async function releaseReservation(
  tx: Tx,
  transferId: string,
  itemId: string,
  at: Date,
): Promise<{ released: boolean }> {
  const rows = await tx
    .update(stockReservations)
    .set({ releasedAt: at })
    .where(
      and(
        eq(stockReservations.transferId, transferId),
        eq(stockReservations.itemId, itemId),
        isNull(stockReservations.releasedAt),
      ),
    )
    .returning({ id: stockReservations.id });
  return { released: rows.length > 0 };
}

export interface StuckTransferRow {
  readonly id: string;
  readonly storeId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly dispatchedAt: Date;
}

/** `in_transit` transfers older than `thresholdDays`, per store. T-135's finding calls this. */
export async function stuckTransfers(
  tx: Tx,
  storeId: string,
  thresholdDays: number,
): Promise<StuckTransferRow[]> {
  const rows = (await tx.execute(sql`
    select id::text as id, store_id::text as store_id, from_location_id::text as from_location_id,
           to_location_id::text as to_location_id, dispatched_at
      from stock_transfers
     where store_id = ${storeId}
       and status = 'in_transit'
       and dispatched_at < now() - (${thresholdDays} || ' days')::interval
     order by dispatched_at asc
  `)) as unknown as {
    id: string;
    store_id: string;
    from_location_id: string;
    to_location_id: string;
    dispatched_at: Date;
  }[];

  return rows.map((r) => ({
    id: r.id,
    storeId: r.store_id,
    fromLocationId: r.from_location_id,
    toLocationId: r.to_location_id,
    dispatchedAt: r.dispatched_at,
  }));
}
