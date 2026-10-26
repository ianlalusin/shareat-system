/**
 * T-398 S5d - the BUYER side of an inter-entity sale: Padre Garcia (PG) receives the shipment note the commissary left, in PG's OWN books.
 *
 * ## What one receive does (QO-1 (a)), all in the caller's transaction
 *
 * ```
 * 1. the S5b definer stamps the shipment received (per-line counts, received total)        - the seller can read it, never write PG's books
 * 2. a `deliveries` row of kind inter_entity linked to the shipment, one line per answered item
 * 3. `receiveDeliveryDocument`: stock movement + FIFO layer per line at the SHIPMENT rate,
 *    entry source stock_receipt     DR 1310 / CR 2120   (goods received, not yet billed)
 * 4. a system supplier bill for the same total, and
 *    entry source stock_receipt_invoice  DR 2120 / CR 2110  party = PG's supplier row for the commissary   (`linkInvoiceToReceipt`)
 * 5. the bill's expense row (posted, credit leg = the total), so PG pays the commissary from its ordinary AP screen (`ap.openItems`)
 * ```
 *
 * Posted at what ARRIVED, not what was shipped: a short line is a smaller bill, round(received x rate, 2) per line.
 *
 * ## Reads (audit finding 4, QI-1 (a))
 *
 * `listInboundShipments` / `getInboundShipment` serve the buyer only the fields QI-1 (a) allows. The narrowing is the repo's SELECT
 * (`interEntityRepo.listInbound` / `findInbound` / `inboundLinesOf`): the void reason, the person who voided, the seller's store and the trade-order
 * ids are never read, so no caller can leak them. No new definer.
 *
 * ## The bill (QI-2 = A)
 *
 * The bill is made by the definer `create_system_supplier_invoice` (flag `system_made`, total = the shipment's received_total, verified by the receiver):
 * exempt from the two-person check only because the database computes and checks it. No admin is needed.
 */
import { authorize, heldCapabilities, type Actor } from '@shareat/auth';
import {
  deliveriesRepo,
  expensesRepo,
  interEntityRepo,
  itemsRepo,
  type Tx,
} from '@shareat/db';
import { addDays, parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { add, money, ZERO, type Money } from '@shareat/core/money';
import { gone, internalFault, refuse } from '../shared/refusal';
import { parseQuantityInput } from '../shared/quantity-input';
import { lineCost } from '../stock/layers';
import { linkInvoiceToReceipt } from '../stock/invoice-link';
import { addQuantity, compareQuantity, isPositiveQuantity, isZeroQuantity, quantity, ZERO_QUANTITY, type Quantity } from '../stock/quantity';
import { receiveDeliveryDocument } from './documents';

// ================================================================================================ reads

export interface InboundShipmentLine {
  readonly id: string;
  readonly lineNo: number;
  readonly itemName: string;
  readonly unit: string;
  readonly quantity: string;
  readonly rate: string;
  readonly lineTotal: string;
  /** What this organisation counted; null until it receives. */
  readonly receivedQuantity: string | null;
}

/** QI-1 (a): exactly what the buyer may see of a shipment. Nothing of the seller's store, costs, orders or staff. */
export interface InboundShipment {
  readonly id: string;
  readonly shippedOn: string;
  readonly status: 'in_transit' | 'received' | 'void';
  readonly billedTotal: string;
  readonly receivedAt: Date | null;
  readonly receivedTotal: string | null;
  readonly lines: readonly InboundShipmentLine[];
}

async function requireReadAccess(tx: Tx, actor: Actor): Promise<void> {
  const held = await heldCapabilities(tx, actor);
  if (!held.has('receive_delivery')) {
    const say = 'You need permission to receive deliveries to see shipments sent to your company.';
    throw refuse('inter-entity inbound read: receive_delivery is not held.', say);
  }
}

function assemble(rows: readonly interEntityRepo.InboundShipmentRow[], lines: readonly interEntityRepo.InboundLineRow[]): InboundShipment[] {
  return rows.map((r) => ({
    id: r.id,
    shippedOn: r.shippedOn,
    status: r.status,
    billedTotal: r.billedTotal,
    receivedAt: r.receivedAt,
    receivedTotal: r.receivedTotal,
    lines: lines
      .filter((l) => l.shipmentId === r.id)
      .map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemName: l.itemName,
        unit: l.unit,
        quantity: l.quantity,
        rate: l.rate,
        lineTotal: l.lineTotal,
        receivedQuantity: l.receivedQuantity,
      })),
  }));
}

/** The shipments addressed to the caller's organisation, newest first (voided ones only with `includeVoid`). */
export async function listInboundShipments(tx: Tx, actor: Actor, opts: { includeVoid?: boolean } = {}): Promise<InboundShipment[]> {
  await requireReadAccess(tx, actor);
  const rows = await interEntityRepo.listInbound(tx, actor.orgId, { includeVoid: opts.includeVoid === true });
  const lines = await interEntityRepo.inboundLinesOf(tx, actor.orgId, rows.map((r) => r.id));
  return assemble(rows, lines);
}

/** One shipment addressed to the caller's organisation, or null (also for another organisation's shipment: the same answer as a missing id). */
export async function getInboundShipment(tx: Tx, actor: Actor, shipmentId: string): Promise<InboundShipment | null> {
  await requireReadAccess(tx, actor);
  const row = await interEntityRepo.findInbound(tx, actor.orgId, shipmentId);
  if (!row) return null;
  const lines = await interEntityRepo.inboundLinesOf(tx, actor.orgId, [row.id]);
  return assemble([row], lines)[0] ?? null;
}

/** What the receipt form offers beside the shipment itself: the supplier it came from and the buyer's own items declared for that supplier. */
export interface InboundReceiveChoices {
  readonly supplierName: string | null;
  readonly items: readonly { readonly id: string; readonly name: string; readonly baseUnit: string }[];
}

export async function getInboundReceiveChoices(tx: Tx, actor: Actor, shipmentId: string): Promise<InboundReceiveChoices | null> {
  await requireReadAccess(tx, actor);
  const row = await interEntityRepo.findInbound(tx, actor.orgId, shipmentId);
  if (!row) return null;
  const supplier = await interEntityRepo.supplierForSeller(tx, actor.orgId, row.sellerOrgId);
  const items = supplier ? await interEntityRepo.declaredItemsOf(tx, actor.orgId, supplier.id) : [];
  return { supplierName: supplier?.name ?? null, items };
}

// ================================================================================================ receive

export interface ReceiveInterEntityLineInput {
  readonly shipmentLineId: string;
  /** The buyer's OWN item this shipment line is mapped to. Required unless the line is received as 0. */
  readonly itemId?: string | null;
  /** In the shipment's unit, as counted at the dock. */
  readonly receivedQuantity: string;
}

export interface ReceiveInterEntityInput {
  readonly shipmentId: string;
  readonly storeId: string;
  readonly lines: readonly ReceiveInterEntityLineInput[];
}

export interface ReceiveInterEntityResult {
  readonly shipmentId: string;
  readonly deliveryId: string;
  readonly receivedTotal: Money;
  readonly receiptEntryId: string;
  readonly billEntryId: string;
  readonly supplierInvoiceId: string;
}

const COMMISSARY_CATEGORY = 'Commissary Purchases';

/**
 * Receive an inter-entity shipment in the caller's (buyer's) books. See the file header for the posting. Every refusal is a RefusalError with a
 * sentence; every precondition is checked BEFORE the first write, and the whole act is one transaction.
 */
export async function receiveInterEntityShipment(tx: Tx, actor: Actor, input: ReceiveInterEntityInput): Promise<ReceiveInterEntityResult> {
  await authorize(tx, actor, 'receive_delivery', { storeId: input.storeId });

  const shipment = await interEntityRepo.findInbound(tx, actor.orgId, input.shipmentId);
  if (!shipment) {
    throw refuse(
      `receiveInterEntityShipment: shipment ${input.shipmentId} is not addressed to organisation ${actor.orgId}.`,
      'That shipment is not addressed to your company.',
    );
  }
  if (shipment.status === 'received') {
    const on = shipment.receivedAt ? toBusinessDate(shipment.receivedAt) : 'an earlier date';
    throw refuse(
      `receiveInterEntityShipment: shipment ${shipment.id} was already received on ${on}.`,
      `This shipment was already received on ${on}.`,
    );
  }
  if (shipment.status === 'void') {
    throw refuse(
      `receiveInterEntityShipment: shipment ${shipment.id} is void.`,
      'This shipment was cancelled by the sender, so it cannot be received.',
    );
  }

  const shipLines = await interEntityRepo.inboundLinesOf(tx, actor.orgId, [shipment.id]);
  if (shipLines.length === 0) {
    throw internalFault(`receiveInterEntityShipment: shipment ${shipment.id} has no lines.`);
  }

  const supplier = await interEntityRepo.supplierForSeller(tx, actor.orgId, shipment.sellerOrgId);
  if (!supplier) {
    throw refuse(
      `receiveInterEntityShipment: organisation ${actor.orgId} has no supplier row linked to seller ${shipment.sellerOrgId}.`,
      'Set up the commissary as one of your suppliers (linked to its company) before receiving its shipments.',
    );
  }
  if (supplier.status !== 'active') {
    throw refuse(
      `receiveInterEntityShipment: supplier ${supplier.id} is ${supplier.status}.`,
      `${supplier.name} is not an active supplier, so its shipment cannot be received.`,
    );
  }

  // Every shipment line answered exactly once; nothing foreign.
  const answerByLine = new Map<string, ReceiveInterEntityLineInput>();
  for (const l of input.lines) {
    if (answerByLine.has(l.shipmentLineId)) {
      throw refuse(`receiveInterEntityShipment: line ${l.shipmentLineId} was sent twice.`, 'A line of this shipment was counted twice. Reload and count each line once.');
    }
    answerByLine.set(l.shipmentLineId, l);
  }
  const knownIds = new Set(shipLines.map((l) => l.id));
  for (const id of answerByLine.keys()) {
    if (!knownIds.has(id)) {
      throw refuse(`receiveInterEntityShipment: line ${id} is not on shipment ${shipment.id}.`, 'A counted line does not belong to this shipment. Reload the page and try again.');
    }
  }

  interface Plan {
    readonly line: interEntityRepo.InboundLineRow;
    readonly received: Quantity;
    readonly itemId: string | null;
    readonly cost: Money;
  }
  const plans: Plan[] = [];
  const mappedIds: string[] = [];
  for (const line of shipLines) {
    const answer = answerByLine.get(line.id);
    const label = `Line ${line.lineNo} (${line.itemName})`;
    if (!answer) {
      throw refuse(`receiveInterEntityShipment: line ${line.lineNo} was not answered.`, `${label} was not counted. Count every line; enter 0 for one that did not arrive.`);
    }
    const received = parseQuantityInput(
      answer.receivedQuantity || '0',
      `receiveInterEntityShipment: ${label} received quantity`,
      `${label}: the received quantity`,
    );
    if (compareQuantity(received, ZERO_QUANTITY) < 0) {
      throw refuse(`receiveInterEntityShipment: ${label} received quantity is negative.`, `${label}: the received quantity can't be less than zero.`);
    }
    if (compareQuantity(received, quantity(line.quantity)) > 0) {
      throw refuse(
        `receiveInterEntityShipment: ${label} received ${received} but only ${line.quantity} was shipped.`,
        `${label}: you counted ${received} ${line.unit} but only ${line.quantity} ${line.unit} was shipped. Count what arrived, up to what was shipped.`,
      );
    }
    const itemId = answer.itemId ? answer.itemId : null;
    if (isPositiveQuantity(received)) {
      if (!itemId) {
        throw refuse(
          `receiveInterEntityShipment: ${label} has no item mapped.`,
          `${label}: choose which of your own items this is. Map the item to ${supplier.name} first if it is not on the list.`,
        );
      }
      mappedIds.push(itemId);
    }
    plans.push({ line, received, itemId, cost: isZeroQuantity(received) ? ZERO : lineCost(received, unitCostOf(line.rate)) });
  }

  if (!plans.some((p) => isPositiveQuantity(p.received))) {
    throw refuse('receiveInterEntityShipment: nothing arrived on any line.', 'Every line is 0, so there is nothing to receive. If nothing arrived, tell the commissary instead.');
  }

  // The mapping: refuse-and-ask (ruling 26 Oct). The item must be declared in supplier_items for PG's supplier row of the commissary.
  const declared = await interEntityRepo.declaredItemIds(tx, actor.orgId, supplier.id, mappedIds);
  for (const p of plans) {
    if (!isPositiveQuantity(p.received)) continue;
    const label = `Line ${p.line.lineNo} (${p.line.itemName})`;
    const item = await itemsRepo.getItemById(tx, actor.orgId, p.itemId!);
    if (!item) {
      throw gone(`receiveInterEntityShipment: ${label} names item ${p.itemId}, which does not exist.`, `the item for ${label}`);
    }
    if (!declared.has(p.itemId!)) {
      throw refuse(
        `receiveInterEntityShipment: ${label} is mapped to item ${item.id}, which is not declared for supplier ${supplier.id}.`,
        `${label}: "${item.name}" is not on ${supplier.name}'s item list. Map the item to ${supplier.name} (Suppliers, items) first, then receive.`,
      );
    }
    if (item.baseUnit.trim().toLowerCase() !== p.line.unit.trim().toLowerCase()) {
      throw refuse(
        `receiveInterEntityShipment: ${label} is in ${p.line.unit} but item ${item.name} is stocked in ${item.baseUnit}.`,
        `${label} was shipped in ${p.line.unit}, but "${item.name}" is stocked in ${item.baseUnit}. Map it to an item with the same unit.`,
      );
    }
    if (item.status !== 'active') {
      throw refuse(
        `receiveInterEntityShipment: ${label} names ${item.name}, which is ${item.status}.`,
        `${label}: "${item.name}" is ${item.status}, so it cannot be received.`,
      );
    }
  }

  const category = await expensesRepo.categoryByNormalisedName(tx, actor.orgId, COMMISSARY_CATEGORY);
  if (!category) {
    throw refuse(
      `receiveInterEntityShipment: expense category "${COMMISSARY_CATEGORY}" is missing.`,
      `Your company has no "${COMMISSARY_CATEGORY}" expense category. Ask an admin to add it before receiving.`,
    );
  }

  const total = add(...plans.map((p) => p.cost), ZERO);

  // 1. The definer stamps the shipment (every line named once; a line that did not arrive is 0.000). It also serialises a double receive.
  const definerTotal = await interEntityRepo.receive(
    tx,
    shipment.id,
    plans.map((p) => ({ lineId: p.line.id, receivedQuantity: p.received })),
  );
  if (money(definerTotal) !== total) {
    throw internalFault(`receiveInterEntityShipment: shipment ${shipment.id} total ${definerTotal} disagrees with the lines' ${total}.`);
  }

  // 2-3. The delivery document and the stock receipt (movement + layer + DR inventory / CR 2120), at the shipment rate.
  const today = toBusinessDate();
  const delivery = await deliveriesRepo.insertDelivery(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    kind: 'inter_entity',
    supplierId: supplier.id,
    referenceNo: null,
    deliveredOn: today,
    proofFileId: null,
    createdBy: actor.personId,
    interEntityShipmentId: shipment.id,
  });
  const delivered = plans.filter((p) => p.itemId !== null);
  await deliveriesRepo.insertDeliveryLines(
    tx,
    delivery.id,
    delivered.map((p) => ({
      lineNo: String(p.line.lineNo),
      itemId: p.itemId!,
      orderedQuantity: quantity(p.line.quantity),
      purchaseUnit: p.line.unit,
      conversionFactor: '1.000000' as never,
      unitCost: unitCostOf(p.line.rate) as never,
      locationId: null,
    })),
  );
  const doc = await deliveriesRepo.getDeliveryDocument(tx, delivery.id);
  if (!doc) throw internalFault(`receiveInterEntityShipment: delivery ${delivery.id} vanished after it was written.`);
  const docLineByNo = new Map(doc.lines.map((l) => [l.lineNo, l]));
  const receipt = await receiveDeliveryDocument(tx, actor, {
    deliveryId: delivery.id,
    lines: delivered.map((p) => {
      const dl = docLineByNo.get(String(p.line.lineNo));
      if (!dl) throw internalFault(`receiveInterEntityShipment: delivery line ${p.line.lineNo} was not written.`);
      return {
        lineId: dl.id,
        receivedQuantity: p.received,
        shortageReason: compareQuantity(p.received, quantity(p.line.quantity)) < 0 && isPositiveQuantity(p.received) ? ('supplier_short' as const) : null,
      };
    }),
  });

  // 4-5. The system bill: supplier invoice (verified), DR 2120 / CR 2110, and the expense row that makes it an open payable.
  const invoiceId = await interEntityRepo.createSystemSupplierInvoice(tx, {
    shipmentId: shipment.id,
    storeId: input.storeId,
    supplierId: supplier.id,
    invoiceDate: today,
    dueDate: supplier.creditTermsDays != null ? addDays(parseBusinessDate(today), supplier.creditTermsDays) : null,
    notes: `Inter-entity shipment ${shipment.id}, billed at what arrived.`,
  });
  const invoice = { id: invoiceId };

  const sumReceived = addQuantity(...plans.map((p) => p.received));
  const bill = await linkInvoiceToReceipt(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    receiptId: delivery.id,
    supplierInvoiceId: invoice.id,
    supplierId: supplier.id,
    invoicedOn: today,
    provisionalTotal: total,
    invoicedTotal: total,
    inventoryAccount: '1310',
    receivedQuantity: sumReceived,
    openQuantity: sumReceived,
    postedBy: actor.personId,
  });
  if (!bill.ok) throw internalFault(`receiveInterEntityShipment: the bill could not be posted - ${bill.reason}`);

  const expense = await expensesRepo.insertExpense(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: today,
    ownerId: null,
    createdBy: actor.personId,
    totalAmount: total,
    categoryId: category.id,
    supplierId: supplier.id,
    supplierInvoiceId: invoice.id,
    particulars: `Shipment from ${supplier.name}, received ${today}`,
  });
  await expensesRepo.markExpensePosted(tx, actor.orgId, expense.id, { journalEntryId: bill.entryId, approvedBy: actor.personId });
  await expensesRepo.insertPayments(tx, expense.id, [{ method: 'credit', amount: total }]);

  return {
    shipmentId: shipment.id,
    deliveryId: delivery.id,
    receivedTotal: total,
    receiptEntryId: receipt.entryId,
    billEntryId: bill.entryId,
    supplierInvoiceId: invoice.id,
  };
}

/** A shipment rate (numeric(14,2) text) as the delivery line's numeric(14,4) unit cost. */
function unitCostOf(rate: string): string {
  return `${rate}00`;
}
