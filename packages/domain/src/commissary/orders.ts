/**
 * The BRANCH's side of a branch order — T-172, built 2026-09-03 (DEF-136).
 *
 * Draft → submit, and the branch's answer to a substitution the commissary proposed. The
 * commissary's side (accept, fulfil, propose, ready, dispatch) is `./fulfilment.ts`; the posting
 * primitives both sides eventually reach are `./transfer.ts` (T-172/T-173) and the trade module
 * that calls them (`../trade`, T-165).
 *
 * ## ⭐ It is `trade_orders`, and the stages are DERIVED
 *
 * T-172 §2 refused a `branch_orders` table, and migration 0070 refused new status values with it:
 * `status` stays `draft | confirmed | dispatched | received | void`, and the ordering conversation
 * lives in `accepted_at`, `ready_at` and `rejected_at`. So v1's `submitted → accepted → fulfilling
 * → ready` is `branchOrderStage()` below — a function of the row, never a column — and "rejected"
 * is a `void` that carries `rejected_at`. A status that changes nothing about the books is a
 * label, not a state (0070's own header).
 *
 * ## ⭐ Invariant 10 is enforced by WHICH STORE a capability resolves at
 *
 * Every function here authorises `place_branch_order` against `requested_by_store_id` — the
 * branch. Every function in `fulfilment.ts` authorises `fulfil_branch_order` against `store_id`
 * — the commissary. There is no column-level "who may write this field" rule; there does not need
 * to be one, because the only code that writes fulfilment columns cannot be reached with a
 * branch-side grant, and vice versa. A person scoped to both stores may do both, which is exactly
 * what an admin is.
 *
 * ## ⭐ Invariant 12 — the category is CAPTURED at submit, from the map, once
 *
 * `submitOrder` copies `expense_category_id` and `is_ledger_only` from `commissary_item_map` onto
 * every line and refuses if any line resolves to neither a branch item nor a ledger-only decision,
 * or to no category. The trigger `trade_orders_submit_hardening` (0070) refuses the same thing at
 * the database; this function exists so the refusal names the ITEM rather than a line id. After
 * submit the line's copy is what the receipt reads (`receiveTradeOrder`), so a map edited while
 * the goods are on a truck cannot silently reclassify them.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  commissaryRepo,
  itemsRepo,
  lowStockRepo,
  refuse,
  tradeRepo,
  transaction,
  type Tx,
  type TradeOrderLineRow,
  type TradeOrderRow,
} from '@shareat/db';
import { branchPriceFor } from '../items';
import { lineCost } from '../stock/layers';
import { isPositiveQuantity, quantity, type Quantity } from '../stock/quantity';

// -----------------------------------------------------------------------------------------------
// The derived stage
// -----------------------------------------------------------------------------------------------

export type BranchOrderStage =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'ready'
  | 'dispatched'
  | 'received'
  | 'rejected'
  | 'cancelled';

export const BRANCH_ORDER_STAGE_LABEL: Readonly<Record<BranchOrderStage, string>> = {
  draft: 'Draft',
  submitted: 'Submitted — awaiting the commissary',
  accepted: 'Accepted — being packed',
  ready: 'Ready to dispatch',
  dispatched: 'In transit',
  received: 'Received',
  rejected: 'Rejected by the commissary',
  cancelled: 'Cancelled',
};

/**
 * ⭐ The stage, from the row. `confirmed` means "submitted" until the commissary accepts, "accepted"
 * until it marks ready, and "ready" after. ⚠️ The one-open-order index (0070) blocks on `status`,
 * so every stage here except `received`, `rejected` and `cancelled` keeps the branch from opening
 * another — v1's rule, kept: goods in transit block until signed for.
 */
export function branchOrderStage(
  o: Pick<TradeOrderRow, 'status' | 'acceptedAt' | 'readyAt' | 'rejectedAt'>,
): BranchOrderStage {
  switch (o.status) {
    case 'draft':
      return 'draft';
    case 'confirmed':
      if (o.readyAt) return 'ready';
      if (o.acceptedAt) return 'accepted';
      return 'submitted';
    case 'dispatched':
      return 'dispatched';
    case 'received':
      return 'received';
    case 'void':
      return o.rejectedAt ? 'rejected' : 'cancelled';
  }
}

/** The stages at which the order is still the branch's to edit, the commissary's to pack, etc. */
export const OPEN_STAGES: ReadonlySet<BranchOrderStage> = new Set(['draft', 'submitted', 'accepted', 'ready', 'dispatched']);

// -----------------------------------------------------------------------------------------------
// Shared helpers — used by fulfilment.ts too
// -----------------------------------------------------------------------------------------------

/** DEF-511: ready is final. Exported so the tests can assert the exact sentence. */
export const READY_IS_FINAL_SENTENCE =
  'This order is marked ready, so its packing list is final. It can now only be dispatched, or rejected so the branch can order again.';

/**
 * Shared by every commissary/branch write that must refuse once the order is ready (DEF-511).
 * @internal — called by `fulfilLine`/`proposeLine` (`./fulfilment.ts`) and `decideProposedLine`
 * (below); exported only because the barrel re-exports this module, not for `apps/` to call.
 */
export function refuseIfReady(stage: BranchOrderStage, order: { id: string }, verb: string): void {
  if (stage === 'ready') {
    throw refuse(`${verb}: order ${order.id} is ready — ready is final (DEF-511)`, READY_IS_FINAL_SENTENCE);
  }
}

/** A branch order: one a BRANCH initiated. `createTradeOrder`'s commissary-initiated transfers are not. */
export async function loadBranchOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<TradeOrderRow & { requestedByStoreId: string }> {
  const order = await tradeRepo.getOrderById(tx, orgId, orderId, opts);
  if (!order) throw new Error(`branch order ${orderId} does not exist.`);
  if (!order.requestedByStoreId) {
    throw new Error(
      `order ${orderId} was entered at the selling store, not requested by a branch — it has no ` +
        'ordering conversation. Use the trade-orders screen for it.',
    );
  }
  return order as TradeOrderRow & { requestedByStoreId: string };
}

export function parseQuantity(raw: string, what: string): Quantity {
  try {
    return quantity(raw.trim());
  } catch {
    throw new Error(`${what}: "${raw}" is not a quantity (up to three decimal places).`);
  }
}

/**
 * A rate as `numeric(14,2)` will store it — rounded half-up to the centavo in integer arithmetic,
 * so `lineCost` multiplies the SAME figure the row keeps and `line_total` can never disagree with
 * `rate × quantity` by a rounding hair.
 */
export function normaliseRate(raw: string, what: string): string {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    throw new Error(`${what}: "${raw}" is not a rate (a non-negative amount, up to four decimals).`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const tenThousandths = BigInt(whole!) * 10_000n + BigInt(frac.padEnd(4, '0'));
  const centavos = (tenThousandths + 50n) / 100n;
  return `${centavos / 100n}.${(centavos % 100n).toString().padStart(2, '0')}`;
}

export interface ResolvedRate {
  rate: string;
  /** Which tier answered — T-171 §5. The margin rule is T-151's and is not re-implemented here. */
  from: 'branch_price' | 'manual_cost';
}

/**
 * ⭐ T-171 §5, the price a branch is charged, in order: the item's branch-price rule (T-151 —
 * which itself walks the slab link, then the item's own landed history), then the commissary's
 * manual cost of last resort on the offering. ⛔ Nothing prices at a silent zero: `null` means
 * "unpriceable", and every caller refuses the line rather than writing ₱0.
 *
 * ⚠️ Shared with T-175's auto-order so a machine-made line and a hand-made one price the same way.
 */
export async function resolveBranchRate(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  itemId: string,
): Promise<ResolvedRate | null> {
  const bp = await branchPriceFor(tx, orgId, itemId);
  if (bp) return { rate: normaliseRate(bp.price, 'branch price'), from: 'branch_price' };
  const manual = await lowStockRepo.offeringCost(tx, orgId, commissaryStoreId, itemId);
  if (manual !== null && manual !== undefined) return { rate: normaliseRate(manual, 'manual cost'), from: 'manual_cost' };
  return null;
}

/** An automatic note on the order's thread — the audit trail of the conversation (T-175). */
export async function noteOnThread(tx: Tx, orgId: string, orderId: string, authorId: string, body: string): Promise<void> {
  await lowStockRepo.postMessage(tx, { orgId, orderId, authorId, body: body.slice(0, 2000) });
}

// -----------------------------------------------------------------------------------------------
// The catalogue a branch orders from — T-171 §4's read path, built here because the order form is
// its first reader.
// -----------------------------------------------------------------------------------------------

export interface CatalogueLine {
  commissaryItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  kind: string;
  branchItemId: string | null;
  branchItemName: string | null;
  branchItemBaseUnit: string | null;
  isLedgerOnly: boolean;
  expenseCategoryId: string | null;
  expenseCategoryLabel: string | null;
  /** `null` with `priced: false` — the order form refuses such a line, visibly (T-171 §5). */
  price: string | null;
  priced: boolean;
  priceFrom: ResolvedRate['from'] | null;
  /** Mapped to a branch item, with a category (or ledger-only) — what submit will demand. */
  submittable: boolean;
  /** Why not, when not. */
  blocker: string | null;
}

export async function orderableCatalogue(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  branchStoreId: string,
): Promise<CatalogueLine[]> {
  const rows = await commissaryRepo.orderableCatalogue(tx, orgId, commissaryStoreId, branchStoreId);
  const out: CatalogueLine[] = [];
  for (const r of rows) {
    const resolved = await resolveBranchRate(tx, orgId, commissaryStoreId, r.commissaryItemId);
    const mapped = r.branchItemId !== null;
    const blocker = !mapped
      ? 'not mapped to a branch item'
      : !r.isLedgerOnly && !r.expenseCategoryId
        ? 'no expense category on its map'
        : null;
    out.push({
      commissaryItemId: r.commissaryItemId,
      code: r.code,
      name: r.name,
      baseUnit: r.baseUnit,
      kind: r.kind,
      branchItemId: r.branchItemId,
      branchItemName: r.branchItemName,
      branchItemBaseUnit: r.branchItemBaseUnit,
      isLedgerOnly: r.isLedgerOnly,
      expenseCategoryId: r.expenseCategoryId,
      expenseCategoryLabel: r.expenseCategoryLabel,
      price: resolved?.rate ?? null,
      priced: resolved !== null,
      priceFrom: resolved?.from ?? null,
      submittable: blocker === null,
      blocker,
    });
  }
  return out;
}

export async function listAvailableCommissaries(tx: Tx, orgId: string, branchStoreId: string) {
  return commissaryRepo.listCommissariesFor(tx, orgId, branchStoreId);
}

// -----------------------------------------------------------------------------------------------
// Building a branch line — one path for the first draft and for every line added after
// -----------------------------------------------------------------------------------------------

export interface BranchLineDraft {
  itemId: string;
  quantity: string;
  /** Omit to take the resolved branch rate. Whatever is used is CAPTURED (invariant 11). */
  rate?: string | null;
}

async function buildBranchLine(
  tx: Tx,
  orgId: string,
  order: { id: string; storeId: string; requestedByStoreId: string },
  draft: BranchLineDraft,
  existing: readonly TradeOrderLineRow[],
): Promise<{ id: string }> {
  const item = await itemsRepo.getItemById(tx, orgId, draft.itemId);
  if (!item) throw new Error('that item does not exist.');
  if (item.status !== 'active') throw new Error(`${item.name} is ${item.status}, not active.`);

  // ⭐ T-171: a branch orders from what its commissary OFFERS — the catalogue, not the whole item
  // master. An item the commissary never said it would dispatch is refused here, by name.
  const offered = await lowStockRepo.offeringCost(tx, orgId, order.storeId, item.id);
  const catalogue = await commissaryRepo.orderableCatalogue(tx, orgId, order.storeId, order.requestedByStoreId);
  if (offered === null && !catalogue.some((c) => c.commissaryItemId === item.id)) {
    throw new Error(`${item.name} is not on the commissary's catalogue — it offers nothing by that name.`);
  }

  // One live line per item — the partial unique index refuses it too; this names the item.
  if (existing.some((l) => l.itemId === item.id && l.approval !== 'rejected')) {
    throw new Error(`${item.name} is already on this order — change its quantity instead.`);
  }

  const qty = parseQuantity(draft.quantity, item.name);
  if (!isPositiveQuantity(qty)) throw new Error(`${item.name}: a quantity must be more than zero.`);

  let rate: string;
  if (draft.rate != null && draft.rate.trim() !== '') {
    rate = normaliseRate(draft.rate, item.name);
  } else {
    const resolved = await resolveBranchRate(tx, orgId, order.storeId, item.id);
    if (!resolved) {
      // ⛔ Never a silent zero — T-171 §5. A ₱0 line becomes a ₱0 order becomes a ₱0 transfer.
      throw new Error(
        `${item.name} cannot be priced: it has no branch-price rule and the commissary set no manual ` +
          'cost for it. Set one on the catalogue, or state a rate on the line.',
      );
    }
    rate = resolved.rate;
  }

  // The map, if it exists today, is copied so the draft already shows what submit will demand.
  // ⚠️ Submit copies it AGAIN — that is the capture point; this is a preview of it.
  const map = await commissaryRepo.mapItem(tx, order.storeId, order.requestedByStoreId, item.id);

  return tradeRepo.insertBranchLine(tx, {
    orgId,
    orderId: order.id,
    itemId: item.id,
    quantity: qty,
    unit: item.baseUnit,
    rate,
    lineTotal: lineCost(qty, rate),
    requestedQuantity: qty,
    fulfilledQuantity: null,
    origin: 'requested',
    approval: 'not_required',
    isLedgerOnly: map?.isLedgerOnly ?? false,
    expenseCategoryId: map?.expenseCategoryId ?? null,
    sourceLocationId: null,
  });
}

// -----------------------------------------------------------------------------------------------
// The branch's mutations
// -----------------------------------------------------------------------------------------------

export interface SaveBranchOrderDraftInput {
  branchStoreId: string;
  commissaryStoreId: string;
  /** YYYY-MM-DD. */
  orderDate: string;
  notes?: string | null;
  lines: readonly BranchLineDraft[];
}

/**
 * A new draft, with its first lines. ⭐ ONE open order per (branch, commissary) — the partial
 * unique index refuses a second; this refuses it first, naming the stage of the one that is open.
 * ⚠️ Refuses an empty draft: the low-stock auto-order (T-175) makes drafts by machine, and a human
 * making one with nothing on it is a mis-click, not an order.
 */
export async function saveBranchOrderDraft(
  tx: Tx | null,
  actor: Actor,
  input: SaveBranchOrderDraftInput,
): Promise<{ orderId: string; totalAmount: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'place_branch_order', { storeId: input.branchStoreId });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.orderDate)) {
      throw new Error('saveBranchOrderDraft: the order date must be YYYY-MM-DD.');
    }
    if (input.commissaryStoreId === input.branchStoreId) {
      throw new Error('saveBranchOrderDraft: a store cannot order from itself.');
    }
    const linked = await commissaryRepo.activeLinkExists(trx, actor.orgId, input.commissaryStoreId, input.branchStoreId);
    if (!linked) {
      throw new Error(
        'saveBranchOrderDraft: this branch is not linked to that commissary. Link them under ' +
          'Inventory › Commissary catalogue first.',
      );
    }
    const customer = await commissaryRepo.internalCustomerFor(trx, actor.orgId, input.branchStoreId);
    if (!customer) {
      throw new Error(
        'saveBranchOrderDraft: this branch has no internal customer record, so an order cannot name ' +
          'it as the receiving party. Re-save the commissary link — it creates one.',
      );
    }
    if (customer.status !== 'active') {
      throw new Error(`saveBranchOrderDraft: the branch's customer record (${customer.name}) is ${customer.status}.`);
    }
    if (input.lines.length === 0) {
      throw new Error('saveBranchOrderDraft: an order needs at least one line.');
    }

    const open = await lowStockRepo.openOrderFor(trx, actor.orgId, input.branchStoreId, input.commissaryStoreId);
    if (open) {
      throw new Error(
        `saveBranchOrderDraft: this branch already has an open order with that commissary (${open.status}). ` +
          'One at a time — add to it, or wait until it is received.',
      );
    }

    const { id: orderId } = await lowStockRepo.createDraftOrder(trx, {
      orgId: actor.orgId,
      commissaryStoreId: input.commissaryStoreId,
      branchStoreId: input.branchStoreId,
      customerId: customer.id,
      orderDate: input.orderDate,
      createdBy: actor.personId,
    });
    if (input.notes?.trim()) await tradeRepo.setNotes(trx, actor.orgId, orderId, input.notes.trim());

    const order = { id: orderId, storeId: input.commissaryStoreId, requestedByStoreId: input.branchStoreId };
    let existing: TradeOrderLineRow[] = [];
    for (const draft of input.lines) {
      await buildBranchLine(trx, actor.orgId, order, draft, existing);
      existing = await tradeRepo.linesFor(trx, actor.orgId, orderId);
    }
    await lowStockRepo.refreshOrderTotal(trx, orderId);
    const saved = await tradeRepo.getOrderById(trx, actor.orgId, orderId);
    return { orderId, totalAmount: saved!.totalAmount };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function addBranchOrderLine(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string } & BranchLineDraft,
): Promise<{ lineId: string }> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'place_branch_order', { storeId: order.requestedByStoreId });
    const stage = branchOrderStage(order);
    if (stage !== 'draft') {
      throw new Error(`addBranchOrderLine: the order is ${BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()} — only a draft takes new lines.`);
    }
    const existing = await tradeRepo.linesFor(trx, actor.orgId, order.id);
    const { id } = await buildBranchLine(trx, actor.orgId, order, input, existing);
    await lowStockRepo.refreshOrderTotal(trx, order.id);
    return { lineId: id };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Change the ASK on a draft line. ⚠️ Only the ask — after submit the branch's numbers are frozen. */
export async function updateBranchOrderLine(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; lineId: string; quantity: string; rate?: string | null },
): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'place_branch_order', { storeId: order.requestedByStoreId });
    const stage = branchOrderStage(order);
    if (stage !== 'draft') {
      throw new Error(`updateBranchOrderLine: the order is ${BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()} — the ask is frozen after submit.`);
    }
    const line = await tradeRepo.getLineById(trx, actor.orgId, input.lineId);
    if (!line || line.orderId !== order.id) throw new Error('updateBranchOrderLine: that line is not on this order.');

    const qty = parseQuantity(input.quantity, 'quantity');
    if (!isPositiveQuantity(qty)) throw new Error('updateBranchOrderLine: a quantity must be more than zero — remove the line instead.');
    const rate = input.rate != null && input.rate.trim() !== '' ? normaliseRate(input.rate, 'rate') : line.rate;

    await tradeRepo.updateLine(trx, actor.orgId, line.id, {
      quantity: qty,
      requestedQuantity: qty,
      rate,
      lineTotal: lineCost(qty, rate),
    });
    await lowStockRepo.refreshOrderTotal(trx, order.id);
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function removeBranchOrderLine(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; lineId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'place_branch_order', { storeId: order.requestedByStoreId });
    const stage = branchOrderStage(order);
    if (stage !== 'draft') {
      throw new Error(`removeBranchOrderLine: the order is ${BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()} — lines cannot be removed after submit.`);
    }
    const line = await tradeRepo.getLineById(trx, actor.orgId, input.lineId);
    if (!line || line.orderId !== order.id) throw new Error('removeBranchOrderLine: that line is not on this order.');
    await tradeRepo.deleteLine(trx, actor.orgId, line.id);
    await lowStockRepo.refreshOrderTotal(trx, order.id);
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Submit — invariant 2's pre-submit hardening, by ITEM NAME. Every line must resolve, through
 * `commissary_item_map`, to a branch item or an explicit ledger-only decision, AND to an expense
 * category unless ledger-only. The resolved values are captured onto the line here (invariant 12's
 * one definition); the trigger refuses the same thing at the database, so the two cannot drift.
 */
export async function submitOrder(tx: Tx | null, actor: Actor, input: { orderId: string }): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'place_branch_order', { storeId: order.requestedByStoreId });
    const stage = branchOrderStage(order);
    if (stage !== 'draft') {
      throw new Error(`submitOrder: the order is already ${BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()}.`);
    }

    const lines = await tradeRepo.linesFor(trx, actor.orgId, order.id);
    if (lines.length === 0) throw new Error('submitOrder: an order with no lines asks for nothing.');

    const maps = await commissaryRepo.mapItems(
      trx, order.storeId, order.requestedByStoreId, lines.map((l) => l.itemId),
    );
    const unresolved: string[] = [];
    for (const line of lines) {
      const item = await itemsRepo.getItemById(trx, actor.orgId, line.itemId);
      const name = item?.name ?? line.itemId;
      if (line.requestedQuantity === null || !isPositiveQuantity(quantity(line.requestedQuantity))) {
        unresolved.push(`${name}: no quantity`);
        continue;
      }
      const map = maps.get(line.itemId);
      if (!map) {
        unresolved.push(`${name}: not mapped to one of this branch's items (or marked ledger-only)`);
        continue;
      }
      if (!map.isLedgerOnly && !map.expenseCategoryId) {
        unresolved.push(`${name}: its map has no expense category`);
        continue;
      }
      // ⭐ The capture. From here the LINE is the truth, and a later map edit does not reach it.
      await tradeRepo.updateLine(trx, actor.orgId, line.id, {
        isLedgerOnly: map.isLedgerOnly,
        expenseCategoryId: map.expenseCategoryId,
      });
    }
    if (unresolved.length > 0) {
      throw new Error(
        `submitOrder: cannot submit — fix these under Inventory › Commissary catalogue first: ${unresolved.join('; ')}.`,
      );
    }

    await tradeRepo.setStatus(trx, actor.orgId, order.id, 'confirmed');
    await lowStockRepo.refreshOrderTotal(trx, order.id);
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ The branch's answer to a commissary-added line (invariant 5 and 6). Approving needs the item
 * mapped — the same rule as ordering, applied at the point the line becomes real — and captures
 * the map exactly as submit does. Rejecting zero-fulfils it: declined, not billed, not dispatched.
 */
export async function decideProposedLine(
  tx: Tx | null,
  actor: Actor,
  input: { orderId: string; lineId: string; decision: 'approved' | 'rejected' },
): Promise<void> {
  const run = async (trx: Tx) => {
    const order = await loadBranchOrder(trx, actor.orgId, input.orderId, { forUpdate: true });
    await authorize(trx, actor, 'place_branch_order', { storeId: order.requestedByStoreId });
    const stage = branchOrderStage(order);
    // T-372 S1 audit finding 1 (DEF-511): a pending line cannot exist once the order is ready
    // (`markReady` refuses pending lines; `proposeLine` is refused at ready), so this refuses too.
    refuseIfReady(stage, order, 'decideProposedLine');
    if (stage !== 'accepted') {
      throw new Error(`decideProposedLine: the order is ${BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()} — there is nothing to decide.`);
    }
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new Error('decideProposedLine: the decision is "approved" or "rejected".');
    }
    const line = await tradeRepo.getLineById(trx, actor.orgId, input.lineId);
    if (!line || line.orderId !== order.id) throw new Error('decideProposedLine: that line is not on this order.');
    if (line.origin !== 'commissary_added' || line.approval !== 'pending') {
      throw new Error('decideProposedLine: that line is not a commissary proposal awaiting a decision.');
    }
    const item = await itemsRepo.getItemById(trx, actor.orgId, line.itemId);
    const name = item?.name ?? line.itemId;

    if (input.decision === 'approved') {
      const map = await commissaryRepo.mapItem(trx, order.storeId, order.requestedByStoreId, line.itemId);
      if (!map) {
        throw new Error(
          `decideProposedLine: map ${name} to one of this branch's items (or mark it ledger-only) under ` +
            'Inventory › Commissary catalogue before approving it.',
        );
      }
      if (!map.isLedgerOnly && !map.expenseCategoryId) {
        throw new Error(`decideProposedLine: ${name}'s map has no expense category — set one before approving it.`);
      }
      await tradeRepo.updateLine(trx, actor.orgId, line.id, {
        approval: 'approved',
        isLedgerOnly: map.isLedgerOnly,
        expenseCategoryId: map.expenseCategoryId,
      });
      await noteOnThread(trx, actor.orgId, order.id, actor.personId, `Approved the commissary's proposed ${name}.`);
    } else {
      await tradeRepo.updateLine(trx, actor.orgId, line.id, {
        approval: 'rejected',
        fulfilledQuantity: quantity('0'),
        lineTotal: '0.00',
      });
      await noteOnThread(trx, actor.orgId, order.id, actor.personId, `Declined the commissary's proposed ${name}.`);
    }
    await lowStockRepo.refreshOrderTotal(trx, order.id);
  };
  if (tx) return run(tx);
  return transaction(run);
}
