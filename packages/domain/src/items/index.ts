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
import { itemsRepo, transaction, type InvoiceLineInput, type Tx } from '@shareat/db';
import type { BaseUnit, ItemKind, PurchaseUnit } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';

export interface CreateItemInput {
  code: string;
  name: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  notes?: string | null;
}

export async function createItem(tx: Tx | null, actor: Actor, input: CreateItemInput): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
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
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function updateItem(
  tx: Tx | null,
  actor: Actor,
  itemId: string,
  values: Partial<{ code: string; name: string; kind: ItemKind; baseUnit: BaseUnit; notes: string | null }>,
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
