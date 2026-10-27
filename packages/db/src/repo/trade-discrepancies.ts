/**
 * The discrepancy table's SQL — T-174. The only place these rows are read or written.
 *
 * ⭐ **`blocking` and `open` are the SAME query, and that is invariant 8.** v1 kept a separate
 * count for the block and a separate list for the screen, and the interesting failure is not that
 * they can disagree — it is that when they do, the screen shows nothing to fix and the block still
 * refuses to open the day. One source, two consumers.
 *
 * ⭐ T-398 S5e (ruling 7, QO-2): ONE deliberate exception to "the same query". A `franchise_credit` row (a short receipt at a franchise,
 * ending in a credit note) is a to-do for the commissary manager, so `unresolved` lists it; but its goods never sat in 1340 and a franchise
 * sale must not stop the commissary opening its next day, so `blocking` leaves it out. They differ by exactly that one predicate, and no
 * month close waits on these rows either (the close reads findings, not this table).
 */
import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { tradeDiscrepancies, type DiscrepancyDirection } from '../../schema/trade-discrepancies';
import type { Money, Quantity } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';

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

/** T-371 C2 — `quantity` is (14,3) and `value` is (14,2), each a brand of its own column's shape. */
export type CreateDiscrepancyInput = Readonly<
  Pick<SafeInsert<typeof tradeDiscrepancies>, 'orgId' | 'storeId' | 'orderId' | 'orderLineId'> & {
    /** T-372 S6b. Defaults to `short`, which is every row there was before an over-receipt could be raised. */
    direction?: DiscrepancyDirection;
    quantity: Quantity;
    value: Money;
    note?: string | null;
  }
>;

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
        // S5e (QO-2): a franchise credit is listed (`unresolved`) but never stops a day - its goods never sat in 1340.
        or(isNull(tradeDiscrepancies.disposition), ne(tradeDiscrepancies.disposition, 'franchise_credit')),
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

export interface FranchiseCreditInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly shipmentLineId: string;
  readonly quantity: Quantity;
  readonly value: Money;
  readonly note: string | null;
}

/**
 * S5e, the 06:30 job: ONE open `franchise_credit` row for a short shipment line, in the SELLER's organisation. Idempotent: the unique index on the
 * order line makes a second run write nothing. Returns true when a row was written.
 */
export async function createFranchiseCredit(tx: Tx, input: FranchiseCreditInput): Promise<boolean> {
  const rows = await tx
    .insert(tradeDiscrepancies)
    .values({
      direction: 'short',
      disposition: 'franchise_credit',
      orgId: input.orgId,
      storeId: input.storeId,
      orderId: input.orderId,
      orderLineId: input.orderLineId,
      interEntityShipmentLineId: input.shipmentLineId,
      quantity: input.quantity,
      value: input.value,
      note: input.note,
    })
    .onConflictDoNothing({ target: tradeDiscrepancies.orderLineId })
    .returning({ id: tradeDiscrepancies.id });
  return rows.length > 0;
}

export interface FranchiseCreditRow {
  readonly id: string;
  readonly shipmentLineId: string;
  readonly orderLineId: string;
  readonly quantity: string;
  readonly value: string;
  readonly status: string;
}

/** The unresolved `franchise_credit` rows of one shipment (read FOR UPDATE: two managers cannot credit the same shortfall twice). */
export async function openFranchiseCreditsOfShipment(tx: Tx, orgId: string, shipmentId: string): Promise<FranchiseCreditRow[]> {
  const rows = (await tx.execute(sql`
    select d.id::text as id, d.inter_entity_shipment_line_id::text as shipment_line_id, d.order_line_id::text as order_line_id,
           d.quantity::text as quantity, d.value::text as value, d.status as status
    from trade_discrepancies d join inter_entity_shipment_lines l on l.id = d.inter_entity_shipment_line_id
    where d.org_id = ${orgId} and l.shipment_id = ${shipmentId} and d.disposition = 'franchise_credit' and d.status <> 'resolved'
    order by l.line_no
    for update of d`)) as unknown as { id: string; shipment_line_id: string; order_line_id: string; quantity: string; value: string; status: string }[];
  return rows.map((r) => ({ id: r.id, shipmentLineId: r.shipment_line_id, orderLineId: r.order_line_id, quantity: r.quantity, value: r.value, status: r.status }));
}

/** S5e: the credit note was posted - the row is resolved as `franchise_credit`, carrying the entry. */
export async function resolveFranchiseCredit(tx: Tx, input: { id: string; journalEntryId: string; resolvedBy: string }): Promise<void> {
  await tx
    .update(tradeDiscrepancies)
    .set({ status: 'resolved', disposition: 'franchise_credit', journalEntryId: input.journalEntryId, resolvedAt: new Date(), resolvedBy: input.resolvedBy, deferredTo: null })
    .where(eq(tradeDiscrepancies.id, input.id));
}
