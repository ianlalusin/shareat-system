/**
 * The stock ledger's SQL — T-161. The only place stock movements are read or written.
 *
 * ⭐ **`onHand` is a query, every time.** There is no balance column to read instead, and adding
 * one would be DEF-075 for the ninth time. If this ever becomes slow the answer is a materialised
 * view refreshed from these rows — derived, rebuildable, and still not authoritative.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { stockMovements } from '../../schema/stock-ledger';
import type { Tx } from '../client';

export interface RecordMovementInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly movedAt: Date;
  /** Signed, in base units. Never zero — the database refuses it. */
  readonly quantity: string;
  readonly kind: (typeof stockMovements.kind)['_']['data'];
  readonly sourceType: string;
  readonly sourceId: string;
  readonly journalEntryId?: string | null;
  readonly reversalOfId?: string | null;
  readonly note?: string | null;
  readonly createdBy: string;
}

export interface StockMovementRow {
  readonly id: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: string;
  readonly kind: string;
  readonly movedAt: Date;
  readonly reversalOfId: string | null;
}

export async function insertMovement(tx: Tx, input: RecordMovementInput): Promise<StockMovementRow> {
  const [row] = await tx
    .insert(stockMovements)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.locationId,
      itemId: input.itemId,
      movedAt: input.movedAt,
      quantity: input.quantity,
      kind: input.kind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      journalEntryId: input.journalEntryId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning({
      id: stockMovements.id,
      itemId: stockMovements.itemId,
      locationId: stockMovements.locationId,
      quantity: stockMovements.quantity,
      kind: stockMovements.kind,
      movedAt: stockMovements.movedAt,
      reversalOfId: stockMovements.reversalOfId,
    });
  return row!;
}

/**
 * ⭐ **Lock the (item, location) pair for the rest of the transaction, then read.**
 *
 * The two named v1 bugs — a meat balance drifting negative and a −20 kg slab drift — are both
 * two concurrent posts reading the same snapshot *outside* a transaction. `SELECT … FOR UPDATE`
 * on the existing rows serialises them: the second caller blocks until the first commits, then
 * reads a total that includes it.
 *
 * ⚠️ It locks the rows that exist, so two writers inserting the FIRST ever movement for a pair do
 * not block each other. That is deliberate and safe: the deferred non-negative trigger still fires
 * at commit and refuses whichever of them overdraws.
 */
export async function onHandForUpdate(
  tx: Tx,
  itemId: string,
  locationId: string,
): Promise<string> {
  await tx.execute(sql`
    select 1 from ${stockMovements}
    where ${stockMovements.itemId} = ${itemId}
      and ${stockMovements.locationId} = ${locationId}
    for update
  `);
  return onHand(tx, itemId, locationId);
}

/** Σ signed movements. `asOf` reads the ledger as it stood at a moment — what a count needs. */
export async function onHand(
  tx: Tx,
  itemId: string,
  locationId: string,
  asOf?: Date,
): Promise<string> {
  const where = asOf
    ? and(
        eq(stockMovements.itemId, itemId),
        eq(stockMovements.locationId, locationId),
        lte(stockMovements.movedAt, asOf),
      )
    : and(eq(stockMovements.itemId, itemId), eq(stockMovements.locationId, locationId));

  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)::text` })
    .from(stockMovements)
    .where(where);
  return row?.total ?? '0';
}

/** Every item with a non-zero balance in a store, for the low-stock list and the count sheet. */
export async function onHandByStore(
  tx: Tx,
  storeId: string,
  asOf?: Date,
): Promise<{ itemId: string; locationId: string; quantity: string }[]> {
  const where = asOf
    ? and(eq(stockMovements.storeId, storeId), lte(stockMovements.movedAt, asOf))
    : eq(stockMovements.storeId, storeId);

  return tx
    .select({
      itemId: stockMovements.itemId,
      locationId: stockMovements.locationId,
      quantity: sql<string>`sum(${stockMovements.quantity})::text`,
    })
    .from(stockMovements)
    .where(where)
    .groupBy(stockMovements.itemId, stockMovements.locationId)
    .having(sql`sum(${stockMovements.quantity}) <> 0`)
    .orderBy(asc(stockMovements.itemId));
}

export async function findMovement(tx: Tx, id: string): Promise<StockMovementRow | undefined> {
  const [row] = await tx
    .select({
      id: stockMovements.id,
      itemId: stockMovements.itemId,
      locationId: stockMovements.locationId,
      quantity: stockMovements.quantity,
      kind: stockMovements.kind,
      movedAt: stockMovements.movedAt,
      reversalOfId: stockMovements.reversalOfId,
    })
    .from(stockMovements)
    .where(eq(stockMovements.id, id));
  return row;
}
