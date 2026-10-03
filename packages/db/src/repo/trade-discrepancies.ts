/**
 * The discrepancy table's SQL — T-174. The only place these rows are read or written.
 *
 * ⭐ **`blocking` and `open` are the SAME query, and that is invariant 8.** v1 kept a separate
 * count for the block and a separate list for the screen, and the interesting failure is not that
 * they can disagree — it is that when they do, the screen shows nothing to fix and the block still
 * refuses to open the day. One source, two consumers.
 */
import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { tradeDiscrepancies, type DiscrepancyDirection } from '../../schema/trade-discrepancies';
import type { Tx } from '../client';

export interface TradeDiscrepancyRow {
  readonly id: string;
  /** T-372 S6b: `short` (fewer arrived than were sent) or `over` (the branch counted more). Fixed at creation. */
  readonly direction: DiscrepancyDirection;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly quantity: string;
  readonly value: string;
  readonly status: string;
  readonly disposition: string | null;
  readonly deferredTo: string | null;
  readonly note: string | null;
}

export interface CreateDiscrepancyInput {
  /** T-372 S6b. Defaults to `short`, which is every row there was before an over-receipt could be raised. */
  readonly direction?: DiscrepancyDirection;
  readonly orgId: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly quantity: string;
  readonly value: string;
  readonly note?: string | null;
}

const COLUMNS = {
  id: tradeDiscrepancies.id,
  direction: tradeDiscrepancies.direction,
  orderId: tradeDiscrepancies.orderId,
  orderLineId: tradeDiscrepancies.orderLineId,
  quantity: tradeDiscrepancies.quantity,
  value: tradeDiscrepancies.value,
  status: tradeDiscrepancies.status,
  disposition: tradeDiscrepancies.disposition,
  deferredTo: tradeDiscrepancies.deferredTo,
  note: tradeDiscrepancies.note,
} as const;

export async function create(tx: Tx, input: CreateDiscrepancyInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(tradeDiscrepancies)
    .values({
      direction: input.direction ?? 'short',
      orgId: input.orgId,
      storeId: input.storeId,
      orderId: input.orderId,
      orderLineId: input.orderLineId,
      quantity: input.quantity,
      value: input.value,
      note: input.note ?? null,
    })
    .returning({ id: tradeDiscrepancies.id });
  return row!;
}

export async function findById(tx: Tx, id: string): Promise<(TradeDiscrepancyRow & { storeId: string }) | null> {
  const [row] = await tx
    .select({ ...COLUMNS, storeId: tradeDiscrepancies.storeId })
    .from(tradeDiscrepancies)
    .where(eq(tradeDiscrepancies.id, id))
    .for('update');
  return row ?? null;
}

/** Everything not yet finished, oldest first — the screen's list. */
export async function unresolved(tx: Tx, orgId: string, storeId: string): Promise<TradeDiscrepancyRow[]> {
  return tx
    .select(COLUMNS)
    .from(tradeDiscrepancies)
    .where(
      and(
        eq(tradeDiscrepancies.orgId, orgId),
        eq(tradeDiscrepancies.storeId, storeId),
        ne(tradeDiscrepancies.status, 'resolved'),
      ),
    )
    .orderBy(asc(tradeDiscrepancies.createdAt));
}

/**
 * ⭐ What stops a new sales day: everything `open`, plus everything `deferred` whose date has
 * ARRIVED. ⚠️ A deferral is a promise to decide by a date, not an exemption — on that date the row
 * blocks exactly like an open one, which is what makes "exactly once" enough.
 *
 * ⛔ Derived from the rows every time (DEF-075). There is no counter and no flag on the store.
 */
export async function blocking(
  tx: Tx,
  orgId: string,
  storeId: string,
  forDate: string,
): Promise<TradeDiscrepancyRow[]> {
  return tx
    .select(COLUMNS)
    .from(tradeDiscrepancies)
    .where(
      and(
        eq(tradeDiscrepancies.orgId, orgId),
        eq(tradeDiscrepancies.storeId, storeId),
        ne(tradeDiscrepancies.status, 'resolved'),
        or(
          isNull(tradeDiscrepancies.deferredTo),
          lte(tradeDiscrepancies.deferredTo, forDate),
        ),
      ),
    )
    .orderBy(asc(tradeDiscrepancies.createdAt));
}

export interface ResolveInput {
  readonly id: string;
  readonly disposition: 'audit' | 'loss' | 'charge' | 'late_receipt' | 'extra_dispatch' | 'return';
  readonly chargePersonId?: string | null;
  readonly note?: string | null;
  readonly journalEntryId?: string | null;
  readonly resolvedBy: string;
}

export async function resolve(tx: Tx, input: ResolveInput): Promise<void> {
  await tx
    .update(tradeDiscrepancies)
    .set({
      // ⚠️ `audit` is a decision to WAIT, so it stays open for the block — invariant 3. The
      // disposition records what was decided; the status records whether it is finished.
      status: input.disposition === 'audit' ? 'open' : 'resolved',
      disposition: input.disposition,
      chargePersonId: input.chargePersonId ?? null,
      note: input.note ?? null,
      journalEntryId: input.journalEntryId ?? null,
      resolvedAt: input.disposition === 'audit' ? null : new Date(),
      resolvedBy: input.disposition === 'audit' ? null : input.resolvedBy,
      // Leaving a deferral behind would trip `trade_discrepancies_deferred_shape_check`.
      deferredTo: null,
    })
    .where(eq(tradeDiscrepancies.id, input.id));
}

/** ⛔ A SECOND deferral is refused by `trade_discrepancies_defer_once_trg`, not by this function. */
export async function defer(tx: Tx, id: string, toDate: string): Promise<void> {
  await tx
    .update(tradeDiscrepancies)
    .set({ status: 'deferred', deferredTo: toDate })
    .where(eq(tradeDiscrepancies.id, id));
}

/** T-173's late-receipt path: the balance turned up, so the dispute closes with no posting here. */
export async function closeAsLateReceipt(tx: Tx, id: string, resolvedBy: string): Promise<void> {
  await tx
    .update(tradeDiscrepancies)
    .set({
      status: 'resolved',
      disposition: 'late_receipt',
      resolvedAt: new Date(),
      resolvedBy,
      deferredTo: null,
    })
    .where(and(eq(tradeDiscrepancies.id, id), sql`${tradeDiscrepancies.status} <> 'resolved'`));
}
