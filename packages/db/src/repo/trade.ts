/**
 * The only place SQL is written for trade orders — sales AND internal transfers. T-132, T-133.
 *
 * ⛔ **No balance lives here.** The receivable an order raises belongs to `ar_charges`, and what
 * the customer still owes is a query over the ledger (`arRepo.positionOf`). An order carries a
 * link to its charge, never a copy of its outstanding amount — v1's stored `outstandingAmount`
 * disagreed with its own inputs on 13.3% of rows, which is what a maintained figure looks like
 * after a year.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Money, Quantity } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';
import { refuse } from '../refusal';
import {
  tradeOrders,
  tradeOrderLines,
  type TradeOrderStatus,
} from '../../schema/trade';

export interface TradeOrderRow {
  id: string;
  orgId: string;
  storeId: string;
  customerId: string;
  orderDate: string;
  referenceNo: string | null;
  notes: string | null;
  status: TradeOrderStatus;
  totalAmount: string;
  /** T-151. Outbound freight, ON TOP of the lines — see `schema/trade.ts`. Always present, `0.00` when none. */
  deliveryFee: string;
  otherFees: string;
  arChargeId: string | null;
  journalEntryId: string | null;
  /** T-172. Set when a BRANCH drafted this order; null for one entered at the selling store. */
  requestedByStoreId: string | null;
  /**
   * ⭐ T-172. The branch order's STAGE markers. `status` stays the five-value set 0070 kept on
   * purpose; "submitted" is `confirmed` with none of these, "accepted" is `confirmed` + `acceptedAt`,
   * "ready" adds `readyAt`, and "rejected" is `void` + `rejectedAt`. Derived by
   * `branchOrderStage()` in the domain — never stored (bible §4.2).
   */
  acceptedAt: Date | null;
  acceptedBy: string | null;
  readyAt: Date | null;
  readyBy: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  dispatchedAt: Date | null;
  dispatchedBy: string | null;
  receivedAt: Date | null;
  receivedBy: string | null;
  creditOverrideBy: string | null;
  creditOverrideReason: string | null;
  /** T-433 S2. The pre-printed BIR booklet number, when someone noted it. */
  birInvoiceNo: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdBy: string;
  createdAt: Date;
}

/** One row of the trade-orders register — the order plus the two facts a list needs joined in. */
export interface TradeOrderListRow {
  id: string;
  storeId: string;
  customerId: string;
  customerName: string;
  /** ⭐ The treatment is DERIVED from this on the screen too, never stored (ADR-008 §2). */
  counterpartyStoreId: string | null;
  orderDate: string;
  referenceNo: string | null;
  status: TradeOrderStatus;
  totalAmount: string;
  lineCount: number;
  dispatchedAt: Date | null;
  receivedAt: Date | null;
}

/**
 * ⭐ DEF-138. Every order this store is on, from EITHER end — as the seller, or as the branch
 * an internal transfer is going to. Same rule as `lowStockRepo.branchOrders`: two screens each
 * showing "my orders" from opposite ends is how the two sides come to disagree about what was
 * sent. An external sale appears only at the selling store; the buyer is not a store.
 */
export async function listOrders(tx: Tx, orgId: string, storeId: string): Promise<TradeOrderListRow[]> {
  const rows = (await tx.execute(sql`
    select o.id, o.store_id as "storeId", o.customer_id as "customerId", c.name as "customerName",
           c.counterparty_store_id as "counterpartyStoreId",
           o.order_date::text as "orderDate", o.reference_no as "referenceNo", o.status,
           o.total_amount::text as "totalAmount",
           (select count(*)::int from trade_order_lines l where l.order_id = o.id) as "lineCount",
           o.dispatched_at as "dispatchedAt", o.received_at as "receivedAt"
    from trade_orders o
    join customers c on c.id = o.customer_id
    where o.org_id = ${orgId}
      and (o.store_id = ${storeId} or c.counterparty_store_id = ${storeId})
    order by o.order_date desc, o.created_at desc
    limit 200
  `)) as unknown as TradeOrderListRow[];
  return rows;
}

export interface TradeOrderLineRow {
  id: string;
  orderId: string;
  itemId: string;
  /**
   * ⚠️ For a BRANCH order this is the branch's ASK (or a proposal's quantity) and never changes
   * after submit; the commissary's answer is `fulfilledQuantity`. Readers that move stock use
   * `fulfilledQuantity ?? quantity` — the one expression, in `dispatchTradeOrder` and
   * `receiveTradeOrder` both.
   */
  quantity: string;
  unit: string;
  rate: string;
  /** For a branch order: (fulfilled ?? requested) × rate — what this line COUNTS for. Zero when fulfilled is zero. */
  lineTotal: string;
  /** T-172. The room the goods leave. Set by `fulfilLine`; T-165 falls back to the store's default. */
  sourceLocationId: string | null;
  /** T-172. What the branch asked for. Null on a commissary-added line and on a sale. */
  requestedQuantity: string | null;
  /** T-172. What the commissary will send. Seeded from `requestedQuantity` at accept (invariant 4); ZERO is "none". */
  fulfilledQuantity: string | null;
  /** T-172. What the branch signed for, written by `confirmReceipt`'s caller. */
  receivedQuantity: string | null;
  /** T-172. `requested` by the branch, or `commissary_added` (a substitution awaiting the branch). */
  origin: 'requested' | 'commissary_added';
  approval: 'not_required' | 'pending' | 'approved' | 'rejected';
  /** T-171 invariant 2. Captured from the map at submit / approval — the explicit "no branch stock moves" decision. */
  isLedgerOnly: boolean;
  /** Captured from the map at submit / approval (invariant 12 — the same category the receipt reads). */
  expenseCategoryId: string | null;
  /** T-175. What the low-stock auto-order proposed; never refreshed. */
  suggestedQuantity: string | null;
  /** T-165/T-172. What the goods cost the commissary at dispatch — `dispatchOrder`'s own output,
   *  persisted here so `confirmReceipt` can read it back rather than being told (T-133 §5). */
  dispatchCost: string | null;
  createdAt: Date;
}

/**
 * ⭐ T-172. Does this line COUNT — toward the total, the dispatch, the receipt? A line the
 * commissary proposed counts for nothing until the branch approves it (invariant 5), and a
 * rejected one never does. ⚠️ One predicate, used by the total refresh, the dispatch and the
 * receipt — three readers, one definition, so they cannot disagree about which lines are real.
 */
export function lineCounts(line: Pick<TradeOrderLineRow, 'approval'>): boolean {
  return line.approval === 'not_required' || line.approval === 'approved';
}

/**
 * T-371 C2 — every numeric column is a `Decimal` brand of that column's own shape, minted by `decimal()`.
 * ✎R13 `deliveryFee` / `otherFees` are NOT NULL DEFAULT '0': a blank is OMITTED so the column default applies.
 */
export type InsertTradeOrderInput = Pick<
  SafeInsert<typeof tradeOrders>,
  'orgId' | 'storeId' | 'customerId' | 'orderDate' | 'createdBy'
> & {
  referenceNo: string | null;
  notes: string | null;
  totalAmount: Money;
  /** T-151. Outbound freight, on top of the lines. Omit for the column default. */
  deliveryFee?: Money;
  otherFees?: Money;
};

export async function insertOrder(tx: Tx, input: InsertTradeOrderInput): Promise<{ id: string }> {
  const [row] = await tx.insert(tradeOrders).values(input).returning({ id: tradeOrders.id });
  return { id: row!.id };
}

export async function insertLines(
  tx: Tx,
  orgId: string,
  orderId: string,
  lines: readonly {
    itemId: string;
    quantity: Quantity;
    unit: string;
    rate: Money;
    lineTotal: Money;
  }[],
): Promise<void> {
  if (lines.length === 0) return;
  const rows = lines.map((l) => ({
    orgId,
    orderId,
    itemId: l.itemId,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    lineTotal: l.lineTotal,
  }));
  await tx.insert(tradeOrderLines).values(rows);
}

export async function getOrderById(
  tx: Tx,
  orgId: string,
  id: string,
  opts: {
    /**
     * ⭐ T-172. `SELECT … FOR UPDATE`, so two people working one order from opposite stores — the
     * commissary marking it ready while the branch is still answering a proposal — serialise on
     * the row instead of both reading the same stage and both proceeding.
     */
    forUpdate?: boolean;
  } = {},
): Promise<TradeOrderRow | undefined> {
  const query = tx
    .select()
    .from(tradeOrders)
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)))
    .limit(1);
  const [row] = opts.forUpdate ? await query.for('update') : await query;
  return row as TradeOrderRow | undefined;
}

export async function linesFor(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<TradeOrderLineRow[]> {
  return (await tx
    .select()
    .from(tradeOrderLines)
    .where(and(eq(tradeOrderLines.orgId, orgId), eq(tradeOrderLines.orderId, orderId)))) as TradeOrderLineRow[];
}

/** ⭐ T-179. A single line, by its own id — what a return line names. */
export async function getLineById(tx: Tx, orgId: string, id: string): Promise<TradeOrderLineRow | undefined> {
  const [row] = await tx
    .select()
    .from(tradeOrderLines)
    .where(and(eq(tradeOrderLines.orgId, orgId), eq(tradeOrderLines.id, id)));
  return row as TradeOrderLineRow | undefined;
}

export async function setStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: TradeOrderStatus,
): Promise<void> {
  await tx
    .update(tradeOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)));
}

export async function markDispatched(
  tx: Tx,
  orgId: string,
  id: string,
  values: {
    /** ⛔ Null for an internal transfer — a branch is not extended credit. */
    arChargeId: string | null;
    journalEntryId: string;
    dispatchedBy: string;
    creditOverrideBy: string | null;
    creditOverrideReason: string | null;
  },
): Promise<void> {
  const updated = await tx
    .update(tradeOrders)
    .set({
      status: 'dispatched',
      arChargeId: values.arChargeId,
      journalEntryId: values.journalEntryId,
      dispatchedBy: values.dispatchedBy,
      dispatchedAt: sql`now()`,
      creditOverrideBy: values.creditOverrideBy,
      creditOverrideReason: values.creditOverrideReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id), inArray(tradeOrders.status, ['draft', 'confirmed'])))
    .returning({ id: tradeOrders.id });
  // T-433: the status guard - a second concurrent dispatch that got past the read is refused, never double-posted.
  if (updated.length === 0) throw refuse(`markDispatched: order ${id} is no longer draft or confirmed.`, 'This order was already dispatched.');
}

export async function markVoided(
  tx: Tx,
  orgId: string,
  id: string,
  values: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(tradeOrders)
    .set({
      status: 'void',
      voidedBy: values.voidedBy,
      voidedAt: sql`now()`,
      voidReason: values.voidReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id), ne(tradeOrders.status, 'void')))
    .returning({ id: tradeOrders.id });
  // Status guard: an already-void order is never overwritten (the first reason and time stand).
  if (updated.length === 0) throw refuse(`markVoided: order ${id} is already void or does not exist.`, 'This order is already void.');
}

/**
 * The rate this customer's price list quotes for an item, or undefined when it quotes none.
 *
 * ⚠️ Read ONCE, at line creation, and then captured onto the line. Nothing downstream re-reads
 * this — that is the whole point of `trade_order_lines.rate` existing as a column.
 */
export async function quotedRate(
  tx: Tx,
  orgId: string,
  customerId: string,
  itemId: string,
): Promise<{ rate: string; unit: string | null } | undefined> {
  const [row] = (await tx.execute(sql`
    select pli.rate::text as rate, pli.unit
    from customers c
    join price_list_items pli on pli.price_list_id = c.price_list_id and pli.org_id = c.org_id
    where c.org_id = ${orgId} and c.id = ${customerId} and pli.item_id = ${itemId}
    limit 1
  `)) as unknown as Record<string, string | null>[];
  if (!row) return undefined;
  return { rate: String(row.rate), unit: row.unit ?? null };
}

/**
 * ⭐ T-165. `dispatchOrder`'s own output, persisted so `confirmReceipt` can read back what the
 * DISPATCHED quantity cost — never `rate`, which carries the margin (T-133 §5's whole point).
 */
export async function setLineDispatchCost(tx: Tx, lineId: string, dispatchCost: Money): Promise<void> {
  await tx.update(tradeOrderLines).set({ dispatchCost }).where(eq(tradeOrderLines.id, lineId));
}

/** ⭐ T-165/T-172. What the branch actually signed for — read back by `receiveTradeOrder`. */
export async function setLineReceivedQuantity(tx: Tx, lineId: string, receivedQuantity: Quantity): Promise<void> {
  await tx.update(tradeOrderLines).set({ receivedQuantity }).where(eq(tradeOrderLines.id, lineId));
}

// ---- T-172: the branch order's own writes ------------------------------------------------------
// ⚠️ These are the ONLY writers of the fulfilment and approval columns. Every one is called from
// `domain/src/commissary/orders.ts` (the branch's side) or `fulfilment.ts` (the commissary's), and
// which file may call which is invariant 10 — "each field has exactly one owner" — made concrete.

export interface InsertBranchLineInput
  extends Pick<SafeInsert<typeof tradeOrderLines>, 'orgId' | 'orderId' | 'itemId' | 'unit'> {
  quantity: Quantity;
  rate: Money;
  lineTotal: Money;
  requestedQuantity: Quantity | null;
  fulfilledQuantity: Quantity | null;
  origin: TradeOrderLineRow['origin'];
  approval: TradeOrderLineRow['approval'];
  isLedgerOnly: boolean;
  expenseCategoryId: string | null;
  sourceLocationId: string | null;
}

export async function insertBranchLine(tx: Tx, input: InsertBranchLineInput): Promise<{ id: string }> {
  const [row] = await tx.insert(tradeOrderLines).values(input).returning({ id: tradeOrderLines.id });
  return row!;
}

/** The writable subset. ⚠️ `quantity` is included only because a DRAFT edit changes the ask itself. */
export interface UpdateLinePatch {
  quantity?: Quantity;
  rate?: Money;
  lineTotal?: Money;
  requestedQuantity?: Quantity | null;
  fulfilledQuantity?: Quantity | null;
  sourceLocationId?: string | null;
  approval?: TradeOrderLineRow['approval'];
  isLedgerOnly?: boolean;
  expenseCategoryId?: string | null;
}

export async function updateLine(tx: Tx, orgId: string, lineId: string, patch: UpdateLinePatch): Promise<void> {
  await tx
    .update(tradeOrderLines)
    .set(patch)
    .where(and(eq(tradeOrderLines.orgId, orgId), eq(tradeOrderLines.id, lineId)));
}

export async function deleteLine(tx: Tx, orgId: string, lineId: string): Promise<void> {
  await tx.delete(tradeOrderLines).where(and(eq(tradeOrderLines.orgId, orgId), eq(tradeOrderLines.id, lineId)));
}

/** The commissary said yes. Seeding `fulfilled_quantity` from the ask is the caller's job (invariant 4). */
export async function markAccepted(tx: Tx, orgId: string, id: string, acceptedBy: string): Promise<void> {
  await tx
    .update(tradeOrders)
    .set({ acceptedBy, acceptedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)));
}

export async function markReady(tx: Tx, orgId: string, id: string, readyBy: string): Promise<void> {
  await tx
    .update(tradeOrders)
    .set({ readyBy, readyAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)));
}

/**
 * The commissary said no. ⚠️ `status` becomes `void` — 0070's decision: v1's separate `rejected`
 * and `cancelled` states change nothing about the books, so they are a reason on a void, not a
 * state. `rejected_at` is what distinguishes the two afterwards.
 */
export async function markRejected(
  tx: Tx,
  orgId: string,
  id: string,
  values: { rejectedBy: string; reason: string },
): Promise<void> {
  await tx
    .update(tradeOrders)
    .set({
      status: 'void',
      rejectedBy: values.rejectedBy,
      rejectedAt: sql`now()`,
      rejectReason: values.reason,
      voidedBy: values.rejectedBy,
      voidedAt: sql`now()`,
      voidReason: values.reason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)));
}

export async function setNotes(tx: Tx, orgId: string, id: string, notes: string | null): Promise<void> {
  await tx
    .update(tradeOrders)
    .set({ notes, updatedAt: sql`now()` })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)));
}

/**
 * Record who signed for the goods. ⚠️ Posts nothing for a same-org transfer — the value already
 * moved at dispatch. See `domain/src/trade`'s `receiveTradeOrder` for why that is a decision.
 */
export async function markReceived(
  tx: Tx,
  orgId: string,
  id: string,
  receivedBy: string,
): Promise<Date> {
  const [row] = await tx
    .update(tradeOrders)
    .set({ status: 'received', receivedBy, receivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)))
    .returning({ receivedAt: tradeOrders.receivedAt });
  return row!.receivedAt!;
}

/** T-433 S2. The order in this org that already carries this booklet number, if any. */
export async function findByBirInvoiceNo(
  tx: Tx,
  orgId: string,
  value: string,
): Promise<{ id: string; referenceNo: string | null } | undefined> {
  const [row] = await tx
    .select({ id: tradeOrders.id, referenceNo: tradeOrders.referenceNo })
    .from(tradeOrders)
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.birInvoiceNo, value)))
    .limit(1);
  return row;
}

/** T-433 S2. Set (or, with null, clear) the booklet number. */
export async function setBirInvoiceNo(tx: Tx, orgId: string, id: string, value: string | null): Promise<void> {
  await tx
    .update(tradeOrders)
    .set({ birInvoiceNo: value, updatedAt: sql`now()` })
    .where(and(eq(tradeOrders.orgId, orgId), eq(tradeOrders.id, id)));
}
