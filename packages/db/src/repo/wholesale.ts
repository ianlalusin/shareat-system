/**
 * The only place SQL is written for wholesale orders. T-132.
 *
 * ⛔ **No balance lives here.** The receivable an order raises belongs to `ar_charges`, and what
 * the customer still owes is a query over the ledger (`arRepo.positionOf`). An order carries a
 * link to its charge, never a copy of its outstanding amount — v1's stored `outstandingAmount`
 * disagreed with its own inputs on 13.3% of rows, which is what a maintained figure looks like
 * after a year.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  wholesaleOrders,
  wholesaleOrderLines,
  type WholesaleOrderStatus,
} from '../../schema/wholesale';

export interface WholesaleOrderRow {
  id: string;
  orgId: string;
  storeId: string;
  customerId: string;
  orderDate: string;
  referenceNo: string | null;
  notes: string | null;
  status: WholesaleOrderStatus;
  totalAmount: string;
  arChargeId: string | null;
  journalEntryId: string | null;
  dispatchedAt: Date | null;
  creditOverrideReason: string | null;
}

export interface WholesaleOrderLineRow {
  id: string;
  orderId: string;
  itemId: string;
  quantity: string;
  unit: string;
  rate: string;
  lineTotal: string;
}

export async function insertOrder(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    customerId: string;
    orderDate: string;
    referenceNo: string | null;
    notes: string | null;
    totalAmount: string;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(wholesaleOrders).values(input).returning({ id: wholesaleOrders.id });
  return { id: row!.id };
}

export async function insertLines(
  tx: Tx,
  orgId: string,
  orderId: string,
  lines: readonly {
    itemId: string;
    quantity: string;
    unit: string;
    rate: string;
    lineTotal: string;
  }[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(wholesaleOrderLines).values(lines.map((l) => ({ ...l, orgId, orderId })));
}

export async function getOrderById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<WholesaleOrderRow | undefined> {
  const [row] = await tx
    .select()
    .from(wholesaleOrders)
    .where(and(eq(wholesaleOrders.orgId, orgId), eq(wholesaleOrders.id, id)))
    .limit(1);
  return row as WholesaleOrderRow | undefined;
}

export async function linesFor(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<WholesaleOrderLineRow[]> {
  return (await tx
    .select()
    .from(wholesaleOrderLines)
    .where(and(eq(wholesaleOrderLines.orgId, orgId), eq(wholesaleOrderLines.orderId, orderId)))) as WholesaleOrderLineRow[];
}

export async function setStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: WholesaleOrderStatus,
): Promise<void> {
  await tx
    .update(wholesaleOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(wholesaleOrders.orgId, orgId), eq(wholesaleOrders.id, id)));
}

export async function markDispatched(
  tx: Tx,
  orgId: string,
  id: string,
  values: {
    arChargeId: string;
    journalEntryId: string;
    dispatchedBy: string;
    creditOverrideBy: string | null;
    creditOverrideReason: string | null;
  },
): Promise<void> {
  await tx
    .update(wholesaleOrders)
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
    .where(and(eq(wholesaleOrders.orgId, orgId), eq(wholesaleOrders.id, id)));
}

export async function markVoided(
  tx: Tx,
  orgId: string,
  id: string,
  values: { voidedBy: string; voidReason: string },
): Promise<void> {
  await tx
    .update(wholesaleOrders)
    .set({
      status: 'void',
      voidedBy: values.voidedBy,
      voidedAt: sql`now()`,
      voidReason: values.voidReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(wholesaleOrders.orgId, orgId), eq(wholesaleOrders.id, id)));
}

/**
 * The rate this customer's price list quotes for an item, or undefined when it quotes none.
 *
 * ⚠️ Read ONCE, at line creation, and then captured onto the line. Nothing downstream re-reads
 * this — that is the whole point of `wholesale_order_lines.rate` existing as a column.
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
