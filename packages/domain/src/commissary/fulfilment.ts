/**
 * The COMMISSARY's side of a branch order — T-172, built 2026-09-03 (DEF-136).
 *
 * Accept or reject what the branch asked, adjust what will actually be sent (quantity, rate,
 * source room — per line), propose a substitution the branch must approve, mark the list final,
 * and hand it to the dispatch. Every function authorises `fulfil_branch_order` — or, for the one
 * that posts, `dispatch_branch_order` — against `store_id`, the commissary; see `./orders.ts`'s
 * header for why that IS invariant 10.
 *
 * ## What v1 gets right here, kept
 *
 * - **Accept seeds fulfilment from the request** (invariant 4): the commissary starts from what was
 *   asked and adjusts, never types the list again.
 * - **Zero is an answer.** `fulfilledQuantity = 0` is *"we couldn't fulfil this line"* (v1's own
 *   comment on `markOrderReadyAction`). Migration 0121 made it representable; before it the only
 *   way to send none was to delete the branch's line, which the commissary may not do.
 * - **A proposal lands `pending` and counts toward nothing** (invariant 5) — not the total, not the
 *   dispatch, and it holds the order back from ready until the branch answers.
 * - **Ready is final (DEF-511, Ian 2026-09-30): after it the list cannot change; the order is
 *   dispatched or rejected.**
 *
 * ## What posts, and where
 *
 * Nothing in this file. `dispatchBranchOrder` checks the stage and calls `dispatchTradeOrder`
 * (`../trade`), which since T-165 relieves the commissary's real layers into `1340` through
 * `./transfer.ts`'s `dispatchOrder`. The receipt (`receiveTradeOrder` → `confirmReceipt`) is where
 * both stores' books move. This file is the conversation before the truck.
 */
import { authorize, type Actor } from '@shareat/auth';
import { commissaryRepo, itemsRepo, lowStockRepo, refuse, stockLocationsRepo, tradeRepo, type Tx } from '@shareat/db';
import { notActiveItemSentence } from '../items/not-active';
import { dispatchTradeOrder, type DispatchResult } from '../trade';
import { money, ZERO, type Money } from '@shareat/core/money';
import { lineCost } from '../stock/layers';
import { isPositiveQuantity, isZeroQuantity, quantity, type Quantity } from '../stock/quantity';
import {
  BRANCH_ORDER_STAGE_LABEL,
  branchOrderStage,
  loadBranchOrder,
  normaliseRate,
  noteOnThread,
  parseQuantity,
  refuseIfReady,
  resolveBranchRate,
} from './orders';
import { assertFieldRules } from '../shared/field-rules-assert';
import { COMMISSARY_LINE_EDIT_RULES, COMMISSARY_ORDER_LINE_RULES } from '../field-rules/commissary';

function refuseUnless(stage: ReturnType<typeof branchOrderStage>, allowed: readonly string[], verb: string): void {
  if (!allowed.includes(stage)) {
    throw new Error(`${verb}: the order is ${BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()}.`);
  }
}

/** A room must be one of THIS commissary's active rooms — stock leaves a place, not a store. */
async function resolveSourceLocation(
  tx: Tx,
  commissaryStoreId: string,
  sourceLocationId: string | null | undefined,
  fallback: string | null,
): Promise<string | null> {
  if (sourceLocationId == null || sourceLocationId === '') return fallback;
  const rooms = await stockLocationsRepo.listActiveLocations(tx, commissaryStoreId);
  if (!rooms.some((r) => r.id === sourceLocationId)) {
    throw new Error('that source room is not one of the commissary\'s active rooms.');
  }
  return sourceLocationId;
}

/**
 * ⭐ Accept: the commissary says it will fill this. Seeds `fulfilled_quantity` from
 * `requested_quantity` on every line (invariant 4), so the packing list starts as the ask.
 */
export async function acceptOrder(tx: Tx, actor: Actor, input: { orderId: string }): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'fulfil_branch_order', { storeId: order.storeId });
    refuseUnless(branchOrderStage(order), ['submitted'], 'acceptOrder');

    for (const line of await tradeRepo.linesFor(trx, actor.orgId, order.id)) {
      if (line.fulfilledQuantity !== null) continue;
      await tradeRepo.updateLine(trx, actor.orgId, line.id, {
        fulfilledQuantity: quantity(line.requestedQuantity ?? line.quantity),
      });
    }
    await tradeRepo.markAccepted(trx, actor.orgId, order.id, actor.personId);
  };
  return run(tx);
}

/**
 * Reject: the commissary will not fill this. ⚠️ Posts nothing — nothing has moved. The order
 * becomes `void` carrying `rejected_at` and the reason, which frees the branch to order again
 * (the one-open-order index ignores `void`).
 */
export async function rejectOrder(
  tx: Tx,
  actor: Actor,
  input: { orderId: string; reason: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'fulfil_branch_order', { storeId: order.storeId });
    refuseUnless(branchOrderStage(order), ['submitted', 'accepted', 'ready'], 'rejectOrder');
    const reason = input.reason.trim();
    if (!reason) throw new Error('rejectOrder: say why — the branch reads this.');

    await tradeRepo.markRejected(trx, actor.orgId, order.id, { rejectedBy: actor.personId, reason });
    await noteOnThread(trx, actor.orgId, order.id, actor.personId, `Rejected the order: ${reason}`);
  };
  return run(tx);
}

export interface FulfilLineInput {
  orderId: string;
  lineId: string;
  /** What will actually be sent. ⭐ Zero is "none of this line". */
  quantity: string;
  /** A stated rate wins and is captured (invariant 11). Omit to keep the line's rate. */
  rate?: string | null;
  /** The room the goods leave. Omit to keep the line's; unset lines fall back to the store default at dispatch. */
  sourceLocationId?: string | null;
}

/**
 * ⭐ Fulfilment: quantity, rate and source room, per line — the commissary's three fields and
 * nobody else's. `line_total` is re-derived from what will be SENT, so the total is what the branch
 * will actually be charged. A rejected proposal is not editable; a pending one is (it is the
 * commissary's own).
 */
export async function fulfilLine(tx: Tx, actor: Actor, input: FulfilLineInput): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'fulfil_branch_order', { storeId: order.storeId });
    assertFieldRules(COMMISSARY_LINE_EDIT_RULES, { quantity: input.quantity, rate: input.rate });
    const stage = branchOrderStage(order);
    refuseIfReady(stage, order, 'fulfilLine');
    refuseUnless(stage, ['accepted'], 'fulfilLine');

    const line = await tradeRepo.getLineById(trx, actor.orgId, input.lineId);
    if (!line || line.orderId !== order.id) throw new Error('fulfilLine: that line is not on this order.');
    if (line.approval === 'rejected') throw new Error('fulfilLine: the branch declined that line — it is not going.');

    const qty: Quantity = parseQuantity(input.quantity, 'fulfilLine');
    if (qty.startsWith('-')) throw new Error('fulfilLine: a fulfilled quantity cannot be negative.');
    const rate = input.rate != null && input.rate.trim() !== '' ? normaliseRate(input.rate, 'fulfilLine') : money(line.rate);
    const sourceLocationId = await resolveSourceLocation(trx, order.storeId, input.sourceLocationId, line.sourceLocationId);

    await tradeRepo.updateLine(trx, actor.orgId, line.id, {
      fulfilledQuantity: qty,
      rate,
      lineTotal: isZeroQuantity(qty) ? ZERO : lineCost(qty, rate),
      sourceLocationId,
    });
    await lowStockRepo.refreshOrderTotal(trx, order.id);
  };
  return run(tx);
}

export interface ProposeLineInput {
  orderId: string;
  itemId: string;
  quantity: string;
  rate?: string | null;
  sourceLocationId?: string | null;
  /** The branch's line this stands in for. Its fulfilment drops to zero — "unavailable, replacement proposed". */
  replacesLineId?: string | null;
  note?: string | null;
}

/**
 * ⭐ A substitution: the commissary is out of what was asked and offers something else. Lands
 * `commissary_added` / `pending`, counts toward nothing until the branch approves (invariant 5),
 * and is announced on the thread so the reason survives the people who made it (T-175).
 */
export async function proposeLine(tx: Tx, actor: Actor, input: ProposeLineInput): Promise<{ lineId: string }> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'fulfil_branch_order', { storeId: order.storeId });
    assertFieldRules(COMMISSARY_ORDER_LINE_RULES, { itemId: input.itemId, quantity: input.quantity, rate: input.rate });
    const stage = branchOrderStage(order);
    refuseIfReady(stage, order, 'proposeLine');
    refuseUnless(stage, ['accepted'], 'proposeLine');

    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error('proposeLine: that item does not exist.');
    if (item.status !== 'active') {
      throw refuse(`proposeLine: ${item.name} is ${item.status}, not active.`, notActiveItemSentence(item.status, 'added to an order'));
    }

    const lines = await tradeRepo.linesFor(trx, actor.orgId, order.id);
    if (lines.some((l) => l.itemId === item.id && l.approval !== 'rejected')) {
      throw new Error(`proposeLine: ${item.name} is already on this order — adjust that line instead.`);
    }

    const qty = parseQuantity(input.quantity, item.name);
    if (!isPositiveQuantity(qty)) throw new Error(`proposeLine: propose more than zero of ${item.name}.`);

    let rate: Money;
    if (input.rate != null && input.rate.trim() !== '') {
      rate = normaliseRate(input.rate, item.name);
    } else {
      const resolved = await resolveBranchRate(trx, actor.orgId, order.storeId, item.id);
      if (!resolved) {
        throw new Error(`proposeLine: ${item.name} cannot be priced — state a rate, or set one on the catalogue.`);
      }
      rate = resolved.rate;
    }
    const sourceLocationId = await resolveSourceLocation(trx, order.storeId, input.sourceLocationId, null);

    let replacedName: string | null = null;
    if (input.replacesLineId) {
      const original = lines.find((l) => l.id === input.replacesLineId);
      if (!original) throw new Error('proposeLine: the line being replaced is not on this order.');
      if (original.origin !== 'requested') throw new Error('proposeLine: only one of the branch\'s own lines can be replaced.');
      const originalItem = await itemsRepo.getItemById(trx, actor.orgId, original.itemId);
      replacedName = originalItem?.name ?? original.itemId;
      // "Unavailable — replacement proposed": none of the original goes. The branch's ask stays on
      // the row as the record of what it wanted.
      await tradeRepo.updateLine(trx, actor.orgId, original.id, { fulfilledQuantity: quantity('0'), lineTotal: ZERO });
    }

    // The map, if any, is previewed here and captured at approval — `decideProposedLine`.
    const map = await commissaryRepo.mapItem(trx, order.storeId, order.requestedByStoreId, item.id);

    const { id } = await tradeRepo.insertBranchLine(trx, {
      orgId: actor.orgId,
      orderId: order.id,
      itemId: item.id,
      quantity: qty,
      unit: item.baseUnit,
      rate,
      lineTotal: lineCost(qty, rate),
      requestedQuantity: null,
      fulfilledQuantity: qty,
      origin: 'commissary_added',
      approval: 'pending',
      isLedgerOnly: map?.isLedgerOnly ?? false,
      expenseCategoryId: map?.expenseCategoryId ?? null,
      sourceLocationId,
    });

    await lowStockRepo.refreshOrderTotal(trx, order.id);
    await noteOnThread(
      trx, actor.orgId, order.id, actor.personId,
      `Proposed ${qty} ${item.baseUnit} ${item.name} at ₱${rate}` +
        (replacedName ? ` to replace ${replacedName}` : '') +
        (input.note?.trim() ? ` — ${input.note.trim()}` : '') +
        '. Awaiting the branch\'s approval.',
    );
    return { lineId: id };
  };
  return run(tx);
}

/**
 * ⭐ Ready: the list is final. Refused while any proposal is unanswered (invariant 5), while any
 * line has no fulfilment figure, and when nothing at all would go — an order that sends nothing is
 * a rejection wearing a different label.
 */
export async function markReady(tx: Tx, actor: Actor, input: { orderId: string }): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'fulfil_branch_order', { storeId: order.storeId });
    refuseUnless(branchOrderStage(order), ['accepted'], 'markReady');

    const lines = await tradeRepo.linesFor(trx, actor.orgId, order.id);
    const pending = lines.filter((l) => l.approval === 'pending');
    if (pending.length > 0) {
      throw new Error(
        `markReady: ${pending.length} proposed line${pending.length === 1 ? '' : 's'} still await the branch's ` +
          'approval or rejection — the order cannot be final until they are answered.',
      );
    }
    const counted = lines.filter(tradeRepo.lineCounts);
    if (counted.some((l) => l.fulfilledQuantity === null)) {
      throw new Error('markReady: every line needs a fulfilment quantity first (zero means none).');
    }
    if (!counted.some((l) => isPositiveQuantity(quantity(l.fulfilledQuantity!)))) {
      throw new Error('markReady: nothing would be sent — every line is at zero. Reject the order instead.');
    }
    await tradeRepo.markReady(trx, actor.orgId, order.id, actor.personId);
  };
  return run(tx);
}

/**
 * ⭐ Dispatch — stock out into `1340`, §5. The one act on this side that posts, and it delegates
 * every posting decision to `dispatchTradeOrder` (T-165): the fail-CLOSED stock gate, the FIFO
 * cost, the entry, the `dispatch_cost` written back per line for the receipt to relieve `1340`
 * at. This function adds only the conversation's rule: a branch order goes out READY or not at
 * all — which the trigger (0121) refuses at the database as well.
 *
 * ⚠️ Named `dispatchBranchOrder`, not the spec's `dispatchOrder`: `./transfer.ts` already exports
 * `dispatchOrder` (the posting primitive) from the same barrel. A spec defect, reported in T-172 §12.
 */
export async function dispatchBranchOrder(
  tx: Tx,
  actor: Actor,
  input: { orderId: string },
): Promise<DispatchResult> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId);
    const stage = branchOrderStage(order);
    if (stage === 'dispatched' || stage === 'received') return dispatchTradeOrder(trx, actor, { orderId: order.id });
    refuseUnless(stage, ['ready'], 'dispatchBranchOrder');
    return dispatchTradeOrder(trx, actor, { orderId: order.id });
  };
  return run(tx);
}
