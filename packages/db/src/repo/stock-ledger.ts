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
import type { Quantity } from '@shareat/core/money';

export interface RecordMovementInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly itemId: string;
  readonly movedAt: Date;
  /** Signed, in base units. Never zero — the database refuses it. */
  readonly quantity: Quantity;
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

/**
 * ⭐ T-165. `dispatchOrder`'s stock gate is keyed by item, store-wide — layers are per STORE, not
 * per location (T-162 invariant 6), so the gate must sum across every room a commissary holds the
 * item in, not just the one line names.
 *
 * ⚠️ **`null` when the store has NEVER moved the item** — not `'0'`. `dispatchOrder`'s gate reads
 * an ABSENT entry as "untracked" and refuses it with *"set the commissary's inventory first"*
 * (T-172 §9.1); a `'0'` would be refused too, but as a plain shortage, and the person fixing it
 * would go looking for a count that does not exist. Found by `branch-orders.test.ts` test 15 on
 * 2026-09-03: the caller was filling the map for every line, so the untracked branch could never
 * fire from the one path a real order takes.
 */
export async function onHandByItemInStore(tx: Tx, storeId: string, itemId: string): Promise<string | null> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)::text`,
      rows: sql<number>`count(*)::int`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.storeId, storeId), eq(stockMovements.itemId, itemId)));
  if (!row || row.rows === 0) return null;
  return row.total;
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

/**
 * ⭐ T-165. `stock_movements_source_pair_key` guarantees at most one non-reversed movement per
 * (source, item, location), so a source id is a safe way to find what a void must give back —
 * without a trade-order line growing its own `movement_id` column to remember it.
 */
export async function movementsBySource(
  tx: Tx,
  sourceType: string,
  sourceId: string,
): Promise<{ id: string; itemId: string; locationId: string; storeId: string }[]> {
  return tx
    .select({
      id: stockMovements.id,
      itemId: stockMovements.itemId,
      locationId: stockMovements.locationId,
      storeId: stockMovements.storeId,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.sourceType, sourceType),
        eq(stockMovements.sourceId, sourceId),
        sql`${stockMovements.reversalOfId} is null`,
      ),
    );
}
