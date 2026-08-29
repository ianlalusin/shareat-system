/**
 * Low stock, thresholds, the auto-order draft, and the order thread — T-175's SQL.
 *
 * ⭐ **`lowStock` is a QUERY, every time.** There is no cached list and no alert table. That is
 * DEF-075's rule, and it bites harder here than usual: a stale low-stock alert is indistinguishable
 * from a real one, so the person reading it cannot tell whether to act.
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { items } from '../../schema/items';
import { storeItemThresholds, tradeOrderMessages } from '../../schema/item-thresholds';
import { stockMovements } from '../../schema/stock-ledger';
import { commissaryItemOfferings, commissaryLinks } from '../../schema/commissary';
import { tradeOrderLines, tradeOrders } from '../../schema/trade';
import type { Tx } from '../client';

export interface LowStockRow {
  readonly itemId: string;
  readonly itemName: string;
  readonly baseUnit: string;
  readonly onHand: string;
  readonly threshold: string;
  /** `threshold − onHand`, never below zero. What the suggestion is computed from. */
  readonly shortfall: string;
}

/**
 * Items at or below their threshold, worst shortfall first.
 *
 * ⭐ **On-hand is summed across the store's LOCATIONS before comparing** — v1's behaviour and the
 * right one. A branch with three kilos in the kitchen and one in the stockroom has four kilos; a
 * per-room comparison would cry low stock while a shelf next door is full.
 *
 * ⚠️ An item with **no threshold row does not appear here**. That is not an oversight to paper over
 * with a default: no threshold is a different state from a threshold of zero, and it is surfaced as
 * a finding (`itemHasNoThreshold`) so it nags a manager instead of hiding.
 */
export async function lowStock(tx: Tx, orgId: string, storeId: string): Promise<LowStockRow[]> {
  const rows = await tx.execute(sql`
    with on_hand as (
      select ${stockMovements.itemId} as item_id,
             coalesce(sum(${stockMovements.quantity}), 0) as qty
      from ${stockMovements}
      where ${stockMovements.orgId} = ${orgId} and ${stockMovements.storeId} = ${storeId}
      group by ${stockMovements.itemId}
    )
    select t.item_id                                   as "itemId",
           i.name                                      as "itemName",
           i.base_unit                                 as "baseUnit",
           coalesce(h.qty, 0)::text                    as "onHand",
           t.low_stock_threshold::text                 as "threshold",
           greatest(t.low_stock_threshold - coalesce(h.qty, 0), 0)::text as "shortfall"
    from ${storeItemThresholds} t
    join ${items} i on i.id = t.item_id
    left join on_hand h on h.item_id = t.item_id
    where t.org_id = ${orgId}
      and t.store_id = ${storeId}
      and i.status = 'active'
      and coalesce(h.qty, 0) <= t.low_stock_threshold
    order by (t.low_stock_threshold - coalesce(h.qty, 0)) desc, i.name asc
  `);
  return rows as unknown as LowStockRow[];
}

/**
 * ⚠️ Active items with stock movement in this store but NO threshold row — the finding's input.
 *
 * ⭐ This is the replacement for v1's forcing function, which blocked a usage post until somebody
 * filled a setting in. **It nags a manager instead of blocking a cook at 11pm**, which is the same
 * information reaching the person who can act on it rather than the person who cannot.
 */
export async function itemsWithoutThreshold(tx: Tx, orgId: string, storeId: string): Promise<{ itemId: string; itemName: string }[]> {
  const rows = await tx.execute(sql`
    select distinct m.item_id as "itemId", i.name as "itemName"
    from ${stockMovements} m
    join ${items} i on i.id = m.item_id
    left join ${storeItemThresholds} t on t.store_id = m.store_id and t.item_id = m.item_id
    where m.org_id = ${orgId} and m.store_id = ${storeId}
      and i.status = 'active' and t.id is null
    order by i.name asc
  `);
  return rows as unknown as { itemId: string; itemName: string }[];
}

export async function setThreshold(
  tx: Tx,
  input: { orgId: string; storeId: string; itemId: string; threshold: string; setBy: string },
): Promise<void> {
  await tx
    .insert(storeItemThresholds)
    .values({
      orgId: input.orgId, storeId: input.storeId, itemId: input.itemId,
      lowStockThreshold: input.threshold, setBy: input.setBy,
    })
    .onConflictDoUpdate({
      target: [storeItemThresholds.storeId, storeItemThresholds.itemId],
      set: { lowStockThreshold: input.threshold, setBy: input.setBy, updatedAt: new Date() },
    });
}

export async function clearThreshold(tx: Tx, storeId: string, itemId: string): Promise<void> {
  await tx
    .delete(storeItemThresholds)
    .where(and(eq(storeItemThresholds.storeId, storeId), eq(storeItemThresholds.itemId, itemId)));
}

/** ⭐ Is this store a BUYER? A commissary restocks from suppliers, never through this path. */
export async function commissaryFor(tx: Tx, orgId: string, branchStoreId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: commissaryLinks.commissaryStoreId })
    .from(commissaryLinks)
    .where(
      and(
        eq(commissaryLinks.orgId, orgId),
        eq(commissaryLinks.branchStoreId, branchStoreId),
        eq(commissaryLinks.status, 'active'),
      ),
    );
  return row?.id ?? null;
}

export interface OpenOrderRow {
  readonly id: string;
  readonly status: string;
}

/**
 * The branch's one open order with this commissary, if there is one.
 *
 * ⚠️ `dispatched` counts as open — v1's reason is the important half: *a dispatched order is
 * goods-in-transit not yet received, so it BLOCKS.* An auto-append must not quietly start a second
 * order while a truck is still on the road.
 */
export async function openOrderFor(
  tx: Tx,
  orgId: string,
  branchStoreId: string,
  commissaryStoreId: string,
): Promise<OpenOrderRow | null> {
  const [row] = await tx
    .select({ id: tradeOrders.id, status: tradeOrders.status })
    .from(tradeOrders)
    .where(
      and(
        eq(tradeOrders.orgId, orgId),
        eq(tradeOrders.requestedByStoreId, branchStoreId),
        eq(tradeOrders.storeId, commissaryStoreId),
        sql`${tradeOrders.status} in ('draft','confirmed','dispatched')`,
      ),
    )
    .for('update');
  return row ?? null;
}

export async function itemsAlreadyOnOrder(tx: Tx, orderId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ itemId: tradeOrderLines.itemId })
    .from(tradeOrderLines)
    .where(and(eq(tradeOrderLines.orderId, orderId), isNotNull(tradeOrderLines.requestedQuantity)));
  return new Set(rows.map((r) => r.itemId));
}

export interface AppendLineInput {
  readonly orgId: string;
  readonly orderId: string;
  readonly itemId: string;
  readonly unit: string;
  readonly suggestedQuantity: string;
  readonly rate: string;
  /**
   * ⛔ Computed by the CALLER with `lineCost`, never here. A repo may not reach into
   * `@shareat/domain` (ADR-004), and doing the multiplication locally would mean floats — the one
   * thing money arithmetic in this codebase never uses.
   */
  readonly lineTotal: string;
  readonly expenseCategoryId?: string | null;
}

export async function appendAutoLine(tx: Tx, input: AppendLineInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(tradeOrderLines)
    .values({
      orgId: input.orgId,
      orderId: input.orderId,
      itemId: input.itemId,
      quantity: input.suggestedQuantity,
      unit: input.unit,
      rate: input.rate,
      lineTotal: input.lineTotal,
      requestedQuantity: input.suggestedQuantity,
      suggestedQuantity: input.suggestedQuantity,
      expenseCategoryId: input.expenseCategoryId ?? null,
    })
    .returning({ id: tradeOrderLines.id });
  return row!;
}

export async function createDraftOrder(
  tx: Tx,
  input: {
    orgId: string; commissaryStoreId: string; branchStoreId: string;
    customerId: string; orderDate: string; createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(tradeOrders)
    .values({
      orgId: input.orgId,
      storeId: input.commissaryStoreId,
      customerId: input.customerId,
      orderDate: input.orderDate,
      status: 'draft',
      // ⚠️ `trade_orders_total_positive_check` refuses zero, and a draft with no lines yet has no
      // total. One centavo is a placeholder the first appended line replaces.
      totalAmount: '0.01',
      requestedByStoreId: input.branchStoreId,
      createdBy: input.createdBy,
    })
    .returning({ id: tradeOrders.id });
  return row!;
}

export async function refreshOrderTotal(tx: Tx, orderId: string): Promise<void> {
  await tx.execute(sql`
    update ${tradeOrders}
    set total_amount = greatest((
      select coalesce(sum(l.line_total), 0) from ${tradeOrderLines} l where l.order_id = ${orderId}
    ), 0.01)
    where id = ${orderId}
  `);
}

// ---- the order thread -------------------------------------------------------------------------

export interface OrderMessageRow {
  readonly id: string;
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: Date;
}

export async function postMessage(
  tx: Tx,
  input: { orgId: string; orderId: string; body: string; authorId: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(tradeOrderMessages)
    .values({ orgId: input.orgId, orderId: input.orderId, body: input.body, authorId: input.authorId })
    .returning({ id: tradeOrderMessages.id });
  return row!;
}

export async function listMessages(tx: Tx, orderId: string): Promise<OrderMessageRow[]> {
  return tx
    .select({
      id: tradeOrderMessages.id,
      body: tradeOrderMessages.body,
      authorId: tradeOrderMessages.authorId,
      createdAt: tradeOrderMessages.createdAt,
    })
    .from(tradeOrderMessages)
    .where(eq(tradeOrderMessages.orderId, orderId))
    .orderBy(asc(tradeOrderMessages.createdAt));
}

/** ⚠️ Both stores are in this conversation — T-173 invariant 8's rule, in one place. */
export async function orderParties(
  tx: Tx,
  orderId: string,
): Promise<{ commissaryStoreId: string; branchStoreId: string | null } | null> {
  const [row] = await tx
    .select({ commissaryStoreId: tradeOrders.storeId, branchStoreId: tradeOrders.requestedByStoreId })
    .from(tradeOrders)
    .where(eq(tradeOrders.id, orderId));
  return row ?? null;
}

/**
 * ⚠️ Tier 3 of T-171's price fallback ONLY — the manager-set cost of last resort on the offering.
 *
 * ⛔ Returns null rather than a zero when the commissary has no price. T-171's rule, and it matters
 * more for a machine-made line than a hand-made one: nobody looks at this one before it lands, and
 * a ₱0 line becomes a ₱0 order becomes a ₱0 receivable that surfaces at month end.
 */
export async function offeringCost(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  itemId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ cost: commissaryItemOfferings.manualCost })
    .from(commissaryItemOfferings)
    .where(
      and(
        eq(commissaryItemOfferings.orgId, orgId),
        eq(commissaryItemOfferings.commissaryStoreId, commissaryStoreId),
        eq(commissaryItemOfferings.itemId, itemId),
        eq(commissaryItemOfferings.status, 'active'),
      ),
    );
  return row?.cost ?? null;
}
