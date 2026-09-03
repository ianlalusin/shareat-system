/**
 * The item master. T-145 — `docs/tasks/145-item-master-and-invoice-lines.md`.
 *
 * ⭐ One identity per purchasable thing, org-wide, with one canonical unit. That is the whole
 * feature: everything else (price history, supplier comparison, and eventually T-146's OCR
 * matching) is a query that only becomes answerable once the identity exists.
 *
 * ⛔ No cost lives here. `itemsRepo.priceHistory` derives it from invoice lines — v1's stored
 * `costPerUnit` is zero on 71% of its items, which is what a snapshot nobody maintains looks
 * like after a year.
 */
import {
  itemsRepo,
  transaction,
  type InvoiceLineInput,
  type ItemRequestRow,
  type MergeReport,
  type SimilarItem,
  type Tx,
} from '@shareat/db';
import type { BaseUnit, ItemKind, PurchaseUnit } from '@shareat/db/schema';
import { computeBranchPrice, type BranchPrice } from './branch-price';
import { authorize, type Actor } from '@shareat/auth';

export interface CreateItemInput {
  code: string;
  name: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  notes?: string | null;
  /** ⭐ T-149. Default: purchasable, sold to nobody — the commonest case by far. */
  isPurchasable?: boolean;
  sellableRetail?: boolean;
  sellableWholesale?: boolean;
}

/**
 * ⛔ **Super-admin only** (Ian, 2026-08-28). Everyone else calls `requestItem` and waits.
 *
 * An item is the identity every price, every supplier link and every future OCR match keys on.
 * A duplicate is not a row you delete afterwards — it is a price history split in two, invisibly,
 * until somebody notices the chart is wrong. One person deciding is the strongest control
 * available, and unlike a similarity threshold it does not degrade as the catalogue grows.
 */
export async function createItem(tx: Tx | null, actor: Actor, input: CreateItemInput): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const code = input.code.trim();
    const name = input.name.trim();
    if (!code) throw new Error('createItem: an item needs a code.');
    if (!name) throw new Error('createItem: an item needs a name people will recognise.');
    return itemsRepo.insertItem(trx, {
      orgId: actor.orgId,
      code,
      name,
      kind: input.kind,
      baseUnit: input.baseUnit,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
      isPurchasable: input.isPurchasable ?? true,
      sellableRetail: input.sellableRetail ?? false,
      sellableWholesale: input.sellableWholesale ?? false,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ DEF-130. The three T-149 flags are editable here too — the ORG's default answer. Until
 * 2026-09-03 this signature did not admit them, so no screen could ever change what an existing
 * item is sold as, and `createItemAction` never passed them either: every item made through the
 * app was sold to nobody, and a wholesale order on it was refused by its own gate. A store that
 * disagrees with the org still says so through `setStoreSellability`, never here.
 */
export async function updateItem(
  tx: Tx | null,
  actor: Actor,
  itemId: string,
  values: Partial<{
    code: string;
    name: string;
    kind: ItemKind;
    baseUnit: BaseUnit;
    notes: string | null;
    isPurchasable: boolean;
    sellableRetail: boolean;
    sellableWholesale: boolean;
  }>,
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, itemId);
    if (!item) throw new Error(`updateItem: item ${itemId} does not exist.`);
    await itemsRepo.updateItem(trx, actor.orgId, itemId, values);
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function deactivateItem(tx: Tx | null, actor: Actor, itemId: string): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    await itemsRepo.updateItem(trx, actor.orgId, itemId, { status: 'inactive' });
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Invoice lines — the rules a line must satisfy before it becomes a price observation
// -------------------------------------------------------------------------------------

export interface InvoiceLineDraft {
  itemId: string;
  description?: string | null;
  quantity: string;
  purchaseUnit: PurchaseUnit;
  /** purchase_unit → the item's base unit. 1 when they are the same unit. */
  conversionFactor: string;
  /** Per PURCHASE unit, as the supplier billed it. */
  unitPrice: string;
  lineTotal: string;
}

/** ₱0.01 — a line's own arithmetic, and the sum against the header. Decimal noise only. */
const LINE_EPSILON = 0.01;

/**
 * ⭐ Validates a set of lines against the invoice they belong to, and returns them numbered.
 *
 * Three rules, each of which exists because of something real:
 *
 * 1. **A line's parts must make its total.** A line whose arithmetic does not close is a typo,
 *    and a typo that gets stored becomes a price observation nobody can distinguish from a real
 *    one. (Also a DB CHECK — this is the readable error.)
 * 2. **`purchaseUnit === baseUnit` ⟹ `conversionFactor === 1`.** v1 has **7 items with
 *    `pack→pack` and 1 with `box→box` at a factor ≠ 1**, which is meaningless: a conversion
 *    between identical units is either 1 or a data error. Industry guidance says flag impossible
 *    conversions; this refuses them instead.
 * 3. **Lines, when present, sum to the header** within ₱0.01. Lines are OPTIONAL — a utility bill
 *    has none — but a partial set that silently disagreed with the total would be worse than
 *    none, because it looks like detail.
 */
export async function validateInvoiceLines(
  trx: Tx,
  orgId: string,
  lines: InvoiceLineDraft[],
  invoiceTotal: string,
  /** ⭐ T-149: purchasability is resolved AT THIS STORE. Lipa makes the bulgogi sauce it sells;
   *  another branch buys it in, and the same item is legitimately both. */
  storeId?: string,
): Promise<InvoiceLineInput[]> {
  if (lines.length === 0) return [];

  let sum = 0;
  const out: InvoiceLineInput[] = [];

  for (const [i, l] of lines.entries()) {
    const item = await itemsRepo.getItemById(trx, orgId, l.itemId);
    if (!item) throw new Error(`validateInvoiceLines: line ${i + 1} names item ${l.itemId}, which does not exist.`);
    if (item.status !== 'active') {
      throw new Error(`validateInvoiceLines: line ${i + 1} names ${item.name}, which is inactive.`);
    }
    // ⭐ T-149. A supplier billing us for something we MAKE means either the item is wrong or the
    // flag is — both worth stopping before it becomes a price observation. Resolved at the
    // invoice's own store when one is known, because the answer genuinely differs by branch.
    const resolved = storeId ? await itemsRepo.sellabilityAt(trx, orgId, l.itemId, storeId) : undefined;
    const purchasableHere = resolved ? resolved.isPurchasable : item.isPurchasable;
    if (!purchasableHere) {
      throw new Error(
        `validateInvoiceLines: line ${i + 1} names ${item.name}, which this store does not buy — ` +
          'it is made here, not purchased. Either the wrong item was picked, or this store should ' +
          'be marked as buying it.',
      );
    }

    const qty = Number(l.quantity);
    const price = Number(l.unitPrice);
    const total = Number(l.lineTotal);
    const factor = Number(l.conversionFactor);

    if (!(qty > 0)) throw new Error(`validateInvoiceLines: line ${i + 1} (${item.name}) needs a quantity above zero.`);
    if (!(factor > 0)) throw new Error(`validateInvoiceLines: line ${i + 1} (${item.name}) needs a conversion factor above zero.`);
    if (Math.abs(qty * price - total) > LINE_EPSILON) {
      throw new Error(
        `validateInvoiceLines: line ${i + 1} (${item.name}) does not add up — ${l.quantity} × ` +
          `₱${l.unitPrice} is ₱${(qty * price).toFixed(2)}, not ₱${l.lineTotal}.`,
      );
    }
    if (l.purchaseUnit === item.baseUnit && Math.abs(factor - 1) > 1e-9) {
      throw new Error(
        `validateInvoiceLines: line ${i + 1} (${item.name}) is billed in ${l.purchaseUnit}, which is ` +
          `already the item's own unit — the conversion factor must be 1, not ${l.conversionFactor}.`,
      );
    }

    sum += total;
    out.push({
      lineNo: i + 1,
      itemId: l.itemId,
      description: l.description?.trim() || null,
      quantity: l.quantity,
      purchaseUnit: l.purchaseUnit,
      conversionFactor: l.conversionFactor,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    });
  }

  if (Math.abs(sum - Number(invoiceTotal)) > LINE_EPSILON) {
    throw new Error(
      `validateInvoiceLines: the lines total ₱${sum.toFixed(2)}, but the invoice says ` +
        `₱${invoiceTotal}. Either the lines are incomplete or the total is wrong — both are worth ` +
        'fixing before this becomes a price everyone trusts.',
    );
  }

  return out;
}

// -------------------------------------------------------------------------------------
// The supplier-item catalogue — T-147
// -------------------------------------------------------------------------------------

/**
 * ⭐ Declare that a supplier *could* sell us an item, before any invoice proves it.
 *
 * ⛔ There is no matching "record that they DID sell it" verb, and that is the design: an
 * observed link is derived from `supplier_invoice_lines` at read time, so recording an invoice
 * already creates it. Nothing to call, nothing to forget to call, nothing to drift.
 */
export async function declareSupplierItem(
  tx: Tx | null,
  actor: Actor,
  input: { supplierId: string; itemId: string; notes?: string | null },
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`declareSupplierItem: item ${input.itemId} does not exist.`);
    if (item.status !== 'active') {
      throw new Error(`declareSupplierItem: ${item.name} is inactive.`);
    }
    return itemsRepo.insertSupplierItem(trx, {
      orgId: actor.orgId,
      supplierId: input.supplierId,
      itemId: input.itemId,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Withdraw a declaration.
 *
 * ⛔ **It cannot reach an observed link, structurally rather than by a check** — an observation is
 * not a row, so there is nothing for DELETE to find. "You cannot un-buy something" needed a guard
 * in the first draft of this design; deriving the observed half removed the need for one.
 */
export async function undeclareSupplierItem(
  tx: Tx | null,
  actor: Actor,
  input: { supplierId: string; itemId: string },
): Promise<{ removed: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const removed = await itemsRepo.deleteSupplierItem(trx, actor.orgId, input.supplierId, input.itemId);
    return { removed };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ T-148 — governance: request, approve, merge
// -------------------------------------------------------------------------------------

/** Renders the similarity hits as one sentence a human can act on. */
function warningFrom(similar: SimilarItem[]): string | null {
  if (similar.length === 0) return null;
  return (
    'Possible duplicate of ' +
    similar
      .map((s) => `"${s.name}" (${s.code}, per ${s.baseUnit}, ${Math.round(s.similarity * 100)}% alike)`)
      .join('; ')
  );
}

export interface RequestItemInput {
  name: string;
  code: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  reason?: string | null;
}

export interface RequestItemResult {
  requestId: string;
  /** Shown to the requester now AND frozen on the request for the approver later. */
  similarWarning: string | null;
  similar: SimilarItem[];
}

/**
 * Ask for an item. Manager and admin may ask; only a super-admin decides.
 *
 * ⚠️ The similarity check WARNS and never blocks — `Coke 1.5` and `Coke 15` are 55% alike and
 * are genuinely different products. Blocking on that would make the catalogue unusable; showing it
 * to two people, the requester and then the approver, is what actually prevents the duplicate.
 */
export async function requestItem(
  tx: Tx | null,
  actor: Actor,
  input: RequestItemInput,
): Promise<RequestItemResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const name = input.name.trim();
    const code = input.code.trim();
    if (!name) throw new Error('requestItem: an item needs a name people will recognise.');
    if (!code) throw new Error('requestItem: an item needs a code.');

    const similar = await itemsRepo.findSimilarItems(trx, actor.orgId, name);
    const similarWarning = warningFrom(similar);

    const { id } = await itemsRepo.insertItemRequest(trx, {
      orgId: actor.orgId,
      name,
      code,
      kind: input.kind,
      baseUnit: input.baseUnit,
      reason: input.reason?.trim() || null,
      similarWarning,
      requestedBy: actor.personId,
    });
    return { requestId: id, similarWarning, similar };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⛔ Super-admin only. Approving MINTS the item in the same transaction, so an approved request
 * that produced nothing cannot exist — the database refuses that shape outright.
 */
export async function approveItemRequest(
  tx: Tx | null,
  actor: Actor,
  input: { requestId: string; note?: string | null },
): Promise<{ itemId: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const req = await itemsRepo.getItemRequestById(trx, actor.orgId, input.requestId);
    if (!req) throw new Error(`approveItemRequest: request ${input.requestId} does not exist.`);
    if (req.status !== 'requested') {
      throw new Error(`approveItemRequest: request is already ${req.status}.`);
    }
    const { id: itemId } = await itemsRepo.insertItem(trx, {
      orgId: actor.orgId,
      code: req.code,
      name: req.name,
      kind: req.kind,
      baseUnit: req.baseUnit,
      notes: `Approved from item request ${req.id}.`,
      createdBy: actor.personId,
    });
    await itemsRepo.decideItemRequest(trx, actor.orgId, req.id, {
      status: 'approved',
      decidedBy: actor.personId,
      decisionNote: input.note?.trim() || null,
      createdItemId: itemId,
    });
    return { itemId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function rejectItemRequest(
  tx: Tx | null,
  actor: Actor,
  input: { requestId: string; note: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const note = input.note.trim();
    // A rejection with no reason teaches the requester nothing, and they will simply ask again.
    if (!note) throw new Error('rejectItemRequest: say why, so the requester knows what to do instead.');
    await itemsRepo.decideItemRequest(trx, actor.orgId, input.requestId, {
      status: 'rejected',
      decidedBy: actor.personId,
      decisionNote: note,
      createdItemId: null,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Merge a duplicate into the item it should have been.
 *
 * ⛔ Super-admin only, and irreversible in practice: every invoice line, price-list rate and
 * supplier link that named the loser now names the winner, and the two histories become one.
 *
 * ⚠️ The loser's row SURVIVES, marked `merged` and pointing at the winner. Deleting it would
 * break the FKs that make the repoint safe, and would erase the fact that the duplicate ever
 * existed — the first thing someone investigating a price anomaly needs to see.
 */
export async function mergeItems(
  tx: Tx | null,
  actor: Actor,
  input: { loserId: string; winnerId: string },
): Promise<MergeReport> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    if (input.loserId === input.winnerId) throw new Error('mergeItems: an item cannot merge into itself.');

    const loser = await itemsRepo.getItemById(trx, actor.orgId, input.loserId);
    const winner = await itemsRepo.getItemById(trx, actor.orgId, input.winnerId);
    if (!loser) throw new Error(`mergeItems: item ${input.loserId} does not exist.`);
    if (!winner) throw new Error(`mergeItems: item ${input.winnerId} does not exist.`);
    if (loser.status === 'merged') throw new Error(`mergeItems: ${loser.name} is already merged.`);
    if (winner.status === 'merged') {
      throw new Error(`mergeItems: ${winner.name} is itself merged — merge into the surviving item.`);
    }
    // ⛔ Different base units means these are not the same thing, or one of them is wrong. Either
    // way, merging would silently reinterpret every past price: in v1's real data `Bean sprout` is
    // kg and `Beans Sprout` is pcs, and combining those turns the ratio into a number with no
    // meaning. Refuse, and make someone fix the unit first.
    if (loser.baseUnit !== winner.baseUnit) {
      throw new Error(
        `mergeItems: ${loser.name} is measured in ${loser.baseUnit} and ${winner.name} in ` +
          `${winner.baseUnit}. Fix the unit on one of them first — merging now would make every ` +
          'past price incomparable.',
      );
    }
    return itemsRepo.mergeItemInto(trx, actor.orgId, input.loserId, input.winnerId);
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** What the super-admin review queue reads. Any manager may LOOK; only a super-admin decides. */
export async function pendingItemRequests(tx: Tx | null, actor: Actor): Promise<ItemRequestRow[]> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    return itemsRepo.listItemRequests(trx, actor.orgId, { status: 'requested' });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Say what ONE store does with an item, where it differs from the org's answer.
 *
 * ⚠️ Pass `null` for a flag to mean *"no opinion, follow the org"* — not `false`. The difference
 * matters: `false` freezes today's default into a copy that stops tracking it.
 */
export async function setStoreSellability(
  tx: Tx | null,
  actor: Actor,
  input: {
    storeId: string;
    itemId: string;
    isPurchasable?: boolean | null;
    sellableRetail?: boolean | null;
    sellableWholesale?: boolean | null;
    note?: string | null;
  },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`setStoreSellability: item ${input.itemId} does not exist.`);

    const p = input.isPurchasable ?? null;
    const r = input.sellableRetail ?? null;
    const w = input.sellableWholesale ?? null;
    if (p === null && r === null && w === null) {
      // The DB refuses this too; saying it here explains WHY rather than quoting a constraint.
      throw new Error(
        'setStoreSellability: an override that overrides nothing is noise that looks like a ' +
          'decision. Clear it instead if this store should follow the organisation.',
      );
    }
    await itemsRepo.upsertStoreSellability(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      itemId: input.itemId,
      isPurchasable: p,
      sellableRetail: r,
      sellableWholesale: w,
      note: input.note?.trim() || null,
      setBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Return a store to the organisation's answer. */
export async function clearStoreSellability(
  tx: Tx | null,
  actor: Actor,
  input: { storeId: string; itemId: string },
): Promise<{ cleared: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const cleared = await itemsRepo.clearStoreSellability(trx, actor.orgId, input.storeId, input.itemId);
    return { cleared };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// =====================================================================================
// T-151 - the branch price
// =====================================================================================

export type { BranchPriceRule, BranchPrice } from './branch-price';
export { computeBranchPrice };

/** Say how an item's branch price is worked out. */
export async function setItemPricing(
  tx: Tx | null,
  actor: Actor,
  input: {
    itemId: string;
    pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
    fixedAmount?: string | null;
    markupPercent?: string | null;
    fixedMarkupAmount?: string | null;
    marginAlertThresholdPct?: string | null;
  },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`setItemPricing: item ${input.itemId} does not exist.`);

    const need = {
      fixed: input.fixedAmount,
      fixed_markup: input.fixedMarkupAmount,
      percent_markup: input.markupPercent,
    }[input.pricingMode];
    if (need == null) {
      throw new Error(
        `setItemPricing: ${input.pricingMode} needs its own number - a mode without one prices ` +
          'at zero, silently.',
      );
    }
    await itemsRepo.upsertItemPricing(trx, {
      orgId: actor.orgId,
      itemId: input.itemId,
      pricingMode: input.pricingMode,
      fixedAmount: input.fixedAmount ?? null,
      markupPercent: input.markupPercent ?? null,
      fixedMarkupAmount: input.fixedMarkupAmount ?? null,
      marginAlertThresholdPct: input.marginAlertThresholdPct ?? null,
      setBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Price this item off ANOTHER item's cost - v1's `costBasisProductId`. Sliced meat prices off its
 * source slab, which is the thing actually bought and so the only one with a real received cost.
 */
export async function setCostBasisItem(
  tx: Tx | null,
  actor: Actor,
  input: { itemId: string; costBasisItemId: string | null },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`setCostBasisItem: item ${input.itemId} does not exist.`);

    if (input.costBasisItemId) {
      if (input.costBasisItemId === input.itemId) {
        throw new Error('setCostBasisItem: an item cannot price off itself.');
      }
      const basis = await itemsRepo.getItemById(trx, actor.orgId, input.costBasisItemId);
      if (!basis) throw new Error('setCostBasisItem: the cost-basis item does not exist.');
      // A chain that loops would resolve forever, or resolve to whichever link happened to be
      // read first. Refused outright rather than depth-limited.
      const seen = new Set<string>([input.itemId]);
      let cursor: string | null = input.costBasisItemId;
      while (cursor) {
        if (seen.has(cursor)) {
          throw new Error(
            'setCostBasisItem: that link would form a cycle, and a cycle prices off itself ' +
              'eventually. Point it at something that has its own purchase history.',
          );
        }
        seen.add(cursor);
        const next = await itemsRepo.getItemById(trx, actor.orgId, cursor);
        cursor = next?.costBasisItemId ?? null;
      }
    }
    await itemsRepo.updateItem(trx, actor.orgId, input.itemId, {
      costBasisItemId: input.costBasisItemId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * What this item should be charged to a branch at, right now.
 *
 * Undefined when nothing can cost it - the caller surfaces that as "cost not set" rather than
 * silently pricing at zero, exactly as v1 does.
 */
export async function branchPriceFor(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<(BranchPrice & { basisFrom: 'own' | 'linked' }) | undefined> {
  const rule = await itemsRepo.getItemPricing(tx, orgId, itemId);
  if (!rule) return undefined;
  const basis = await itemsRepo.costBasisFor(tx, orgId, itemId);
  // A fixed price needs no basis at all - it is a number somebody chose.
  if (!basis && rule.pricingMode !== 'fixed') return undefined;
  const computed = computeBranchPrice(rule, basis?.basis ?? '0');
  return { ...computed, basisFrom: basis?.basisFrom ?? 'own' };
}
