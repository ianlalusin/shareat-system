/**
 * The inter-entity shipment's SQL - T-398 S5 (migration 0218). The only place these rows are read or written.
 *
 * ## The one defined cross-organisation handoff
 *
 * The commissary (the SELLER, `org_id`) writes a shipment note in the same transaction as its sale. The franchise (the BUYER,
 * `buyer_org_id`) may READ it and stamp "received" through {@link receive}, the only thing the buyer ever writes into the seller's table.
 * The three SECURITY DEFINER functions are called here and nowhere else (RULES: SQL lives in the repo).
 *
 * - Seller functions run under the seller's principal: {@link create}, {@link findByTradeOrder}, {@link linesOf}, {@link markVoid}, {@link setBirInvoiceNo},
 *   {@link buyerPosted}, {@link counterpartyBalance}.
 * - Buyer functions run under the buyer's principal: {@link listInbound}, {@link findById}, {@link receive}.
 *
 * Money is `numeric`, never float: every amount in and out is a decimal string (a branded `Money` / `Quantity` going in).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { interEntityShipmentLines, interEntityShipments, type InterEntityShipmentStatus } from '../../schema/inter-entity';
import { items } from '../../schema/items';
import { supplierItems } from '../../schema/supplier-items';
import { suppliers } from '../../schema/suppliers';
import type { Money, Quantity } from '@shareat/core/money';
import type { Tx } from '../client';

export interface InterEntityShipmentRow {
  readonly id: string;
  readonly orgId: string;
  readonly buyerOrgId: string;
  readonly tradeOrderId: string;
  readonly storeId: string;
  readonly shippedOn: string;
  readonly birInvoiceNo: string | null;
  readonly billedTotal: string;
  readonly creditedTotal: string;
  readonly status: InterEntityShipmentStatus;
  readonly receivedAt: Date | null;
  readonly receivedBy: string | null;
  readonly receivedTotal: string | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
}

export interface InterEntityShipmentLineRow {
  readonly id: string;
  readonly shipmentId: string;
  readonly tradeOrderLineId: string;
  readonly lineNo: number;
  readonly itemName: string;
  readonly unit: string;
  readonly quantity: string;
  readonly rate: string;
  readonly lineTotal: string;
  /** What the buyer counted; NULL until the shipment is received (QI-1 (a)). */
  readonly receivedQuantity: string | null;
}

export interface CreateShipmentLineInput {
  readonly tradeOrderLineId: string;
  readonly lineNo: number;
  readonly itemName: string;
  readonly unit: string;
  readonly quantity: Quantity;
  readonly rate: Money;
  readonly lineTotal: Money;
}

export interface CreateShipmentInput {
  readonly orgId: string;
  readonly buyerOrgId: string;
  readonly tradeOrderId: string;
  readonly storeId: string;
  /** YYYY-MM-DD. */
  readonly shippedOn: string;
  readonly birInvoiceNo?: string | null;
  readonly billedTotal: Money;
  readonly lines: readonly CreateShipmentLineInput[];
}

const SHIPMENT_COLUMNS = {
  id: interEntityShipments.id,
  orgId: interEntityShipments.orgId,
  buyerOrgId: interEntityShipments.buyerOrgId,
  tradeOrderId: interEntityShipments.tradeOrderId,
  storeId: interEntityShipments.storeId,
  shippedOn: interEntityShipments.shippedOn,
  birInvoiceNo: interEntityShipments.birInvoiceNo,
  billedTotal: interEntityShipments.billedTotal,
  creditedTotal: interEntityShipments.creditedTotal,
  status: interEntityShipments.status,
  receivedAt: interEntityShipments.receivedAt,
  receivedBy: interEntityShipments.receivedBy,
  receivedTotal: interEntityShipments.receivedTotal,
  voidedAt: interEntityShipments.voidedAt,
  voidReason: interEntityShipments.voidReason,
} as const;

const LINE_COLUMNS = {
  id: interEntityShipmentLines.id,
  shipmentId: interEntityShipmentLines.shipmentId,
  tradeOrderLineId: interEntityShipmentLines.tradeOrderLineId,
  lineNo: interEntityShipmentLines.lineNo,
  itemName: interEntityShipmentLines.itemName,
  unit: interEntityShipmentLines.unit,
  quantity: interEntityShipmentLines.quantity,
  rate: interEntityShipmentLines.rate,
  lineTotal: interEntityShipmentLines.lineTotal,
  receivedQuantity: interEntityShipmentLines.receivedQuantity,
} as const;

/** SELLER, in the dispatch transaction: the shipment and its line snapshot. The database refuses an unlinked buyer (the link trigger). */
export async function create(tx: Tx, input: CreateShipmentInput): Promise<{ id: string; lineIds: string[] }> {
  const [head] = await tx
    .insert(interEntityShipments)
    .values({
      orgId: input.orgId,
      buyerOrgId: input.buyerOrgId,
      tradeOrderId: input.tradeOrderId,
      storeId: input.storeId,
      shippedOn: input.shippedOn,
      birInvoiceNo: input.birInvoiceNo ?? null,
      billedTotal: input.billedTotal,
    })
    .returning({ id: interEntityShipments.id });
  const lineRows = await tx
    .insert(interEntityShipmentLines)
    .values(
      input.lines.map((l) => ({
        orgId: input.orgId,
        buyerOrgId: input.buyerOrgId,
        shipmentId: head!.id,
        tradeOrderLineId: l.tradeOrderLineId,
        lineNo: l.lineNo,
        itemName: l.itemName,
        unit: l.unit,
        quantity: l.quantity,
        rate: l.rate,
        lineTotal: l.lineTotal,
      })),
    )
    .returning({ id: interEntityShipmentLines.id, lineNo: interEntityShipmentLines.lineNo });
  return { id: head!.id, lineIds: [...lineRows].sort((a, b) => a.lineNo - b.lineNo).map((r) => r.id) };
}

/** SELLER: the shipment for one trade order, or null (also the idempotency check of a retried dispatch). `lock` takes FOR UPDATE. */
export async function findByTradeOrder(tx: Tx, orgId: string, tradeOrderId: string, lock = false): Promise<InterEntityShipmentRow | null> {
  const q = tx
    .select(SHIPMENT_COLUMNS)
    .from(interEntityShipments)
    .where(and(eq(interEntityShipments.orgId, orgId), eq(interEntityShipments.tradeOrderId, tradeOrderId)));
  const [row] = await (lock ? q.for('update') : q);
  return row ?? null;
}

/**
 * SELLER: keep the shipment's booklet number in step with the order's, whatever the shipment's status (a number noted or changed after
 * Padre Garcia received still reaches the note it can read). A no-op when the order has no shipment (an ordinary sale).
 */
export async function setBirInvoiceNo(tx: Tx, orgId: string, tradeOrderId: string, value: string | null): Promise<void> {
  await tx
    .update(interEntityShipments)
    .set({ birInvoiceNo: value, updatedAt: sql`now()` })
    .where(and(eq(interEntityShipments.orgId, orgId), eq(interEntityShipments.tradeOrderId, tradeOrderId)));
}

/** Either side (RLS admits the seller and the buyer): one shipment by id. */
export async function findById(tx: Tx, id: string): Promise<InterEntityShipmentRow | null> {
  const [row] = await tx.select(SHIPMENT_COLUMNS).from(interEntityShipments).where(eq(interEntityShipments.id, id));
  return row ?? null;
}

/** Either side: the lines of one shipment in line order. */
export async function linesOf(tx: Tx, shipmentId: string): Promise<InterEntityShipmentLineRow[]> {
  return tx.select(LINE_COLUMNS).from(interEntityShipmentLines).where(eq(interEntityShipmentLines.shipmentId, shipmentId)).orderBy(asc(interEntityShipmentLines.lineNo));
}

/**
 * BUYER read shape (QI-1 (a)): the ONLY columns of a shipment the buyer's screens may carry. Never the void reason, the person who voided, the seller's
 * store or the trade-order ids - those columns are not selected here (audit finding 4: the narrowing is done by this SELECT, not by the caller).
 * `sellerOrgId` is for the buyer's own supplier lookup (it already knows who the supplier is) and is dropped before anything reaches a screen.
 */
export interface InboundShipmentRow {
  readonly id: string;
  readonly sellerOrgId: string;
  readonly shippedOn: string;
  readonly status: InterEntityShipmentStatus;
  readonly billedTotal: string;
  readonly receivedAt: Date | null;
  readonly receivedTotal: string | null;
}

export interface InboundLineRow {
  readonly id: string;
  readonly shipmentId: string;
  readonly lineNo: number;
  readonly itemName: string;
  readonly unit: string;
  readonly quantity: string;
  readonly rate: string;
  readonly lineTotal: string;
  readonly receivedQuantity: string | null;
}

const INBOUND_COLUMNS = {
  id: interEntityShipments.id,
  sellerOrgId: interEntityShipments.orgId,
  shippedOn: interEntityShipments.shippedOn,
  status: interEntityShipments.status,
  billedTotal: interEntityShipments.billedTotal,
  receivedAt: interEntityShipments.receivedAt,
  receivedTotal: interEntityShipments.receivedTotal,
} as const;

const INBOUND_LINE_COLUMNS = {
  id: interEntityShipmentLines.id,
  shipmentId: interEntityShipmentLines.shipmentId,
  lineNo: interEntityShipmentLines.lineNo,
  itemName: interEntityShipmentLines.itemName,
  unit: interEntityShipmentLines.unit,
  quantity: interEntityShipmentLines.quantity,
  rate: interEntityShipmentLines.rate,
  lineTotal: interEntityShipmentLines.lineTotal,
  receivedQuantity: interEntityShipmentLines.receivedQuantity,
} as const;

/** BUYER: the shipments addressed to `buyerOrgId`, newest first, QI-1 (a) columns only. Voided ones are left out unless `includeVoid`. */
export async function listInbound(
  tx: Tx,
  buyerOrgId: string,
  opts: { status?: InterEntityShipmentStatus; includeVoid?: boolean } = {},
): Promise<InboundShipmentRow[]> {
  const conds = [eq(interEntityShipments.buyerOrgId, buyerOrgId)];
  if (opts.status) conds.push(eq(interEntityShipments.status, opts.status));
  else if (!opts.includeVoid) conds.push(inArray(interEntityShipments.status, ['in_transit', 'received']));
  return tx
    .select(INBOUND_COLUMNS)
    .from(interEntityShipments)
    .where(and(...conds))
    .orderBy(desc(interEntityShipments.shippedOn), desc(interEntityShipments.id));
}

/** BUYER: one shipment addressed to `buyerOrgId`, QI-1 (a) columns only; null for a missing id or another organisation's shipment. */
export async function findInbound(tx: Tx, buyerOrgId: string, id: string): Promise<InboundShipmentRow | null> {
  const [row] = await tx
    .select(INBOUND_COLUMNS)
    .from(interEntityShipments)
    .where(and(eq(interEntityShipments.buyerOrgId, buyerOrgId), eq(interEntityShipments.id, id)));
  return row ?? null;
}

/** BUYER: the lines of the given shipments (QI-1 (a) columns only: no trade-order line id), in shipment then line order. */
export async function inboundLinesOf(tx: Tx, buyerOrgId: string, shipmentIds: readonly string[]): Promise<InboundLineRow[]> {
  if (shipmentIds.length === 0) return [];
  return tx
    .select(INBOUND_LINE_COLUMNS)
    .from(interEntityShipmentLines)
    .where(and(eq(interEntityShipmentLines.buyerOrgId, buyerOrgId), inArray(interEntityShipmentLines.shipmentId, [...shipmentIds])))
    .orderBy(asc(interEntityShipmentLines.shipmentId), asc(interEntityShipmentLines.lineNo));
}

export interface CounterpartySupplierRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly creditTermsDays: number | null;
}

/** BUYER: the buyer's own supplier row for the selling organisation (`suppliers.counterparty_org_id`), or null when none is set up. */
export async function supplierForSeller(tx: Tx, buyerOrgId: string, sellerOrgId: string): Promise<CounterpartySupplierRow | null> {
  const [row] = await tx
    .select({ id: suppliers.id, name: suppliers.name, status: suppliers.status, creditTermsDays: suppliers.creditTermsDays })
    .from(suppliers)
    .where(and(eq(suppliers.orgId, buyerOrgId), eq(suppliers.counterpartyOrgId, sellerOrgId)))
    .orderBy(asc(suppliers.createdAt))
    .limit(1);
  return row ?? null;
}

export interface DeclaredItemRow {
  readonly id: string;
  readonly name: string;
  readonly baseUnit: string;
}

/** BUYER: the active items the buyer has declared in `supplier_items` for that supplier (the choices on the receipt form). */
export async function declaredItemsOf(tx: Tx, buyerOrgId: string, supplierId: string): Promise<DeclaredItemRow[]> {
  return tx
    .select({ id: items.id, name: items.name, baseUnit: items.baseUnit })
    .from(supplierItems)
    .innerJoin(items, eq(items.id, supplierItems.itemId))
    .where(and(eq(supplierItems.orgId, buyerOrgId), eq(supplierItems.supplierId, supplierId), eq(items.status, 'active')))
    .orderBy(asc(items.name));
}

/** BUYER: which of `itemIds` the buyer has declared in `supplier_items` for that supplier. */
export async function declaredItemIds(tx: Tx, buyerOrgId: string, supplierId: string, itemIds: readonly string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await tx
    .select({ itemId: supplierItems.itemId })
    .from(supplierItems)
    .where(and(eq(supplierItems.orgId, buyerOrgId), eq(supplierItems.supplierId, supplierId), inArray(supplierItems.itemId, [...itemIds])));
  return new Set(rows.map((r) => r.itemId));
}

/** SELLER: an in-transit shipment becomes void with the order's void. The caller holds the row FOR UPDATE ({@link findByTradeOrder}). */
export async function markVoid(tx: Tx, input: { shipmentId: string; voidedBy: string; reason: string }): Promise<void> {
  await tx
    .update(interEntityShipments)
    .set({ status: 'void', voidedAt: sql`now()`, voidedBy: input.voidedBy, voidReason: input.reason, updatedAt: sql`now()` })
    .where(and(eq(interEntityShipments.id, input.shipmentId), eq(interEntityShipments.status, 'in_transit')));
}

export interface CountedLineInput {
  readonly lineId: string;
  readonly receivedQuantity: Quantity;
}

/**
 * BUYER, in the receive transaction: `receive_inter_entity_shipment`. Every line of the shipment is named once (a line that did not arrive is
 * `0.000`). Returns the received total, summed per line as round(received x rate, 2). The database refuses a shipment not addressed to the
 * caller, a void or already-received one, and a received quantity above the shipped one, in words.
 */
export async function receive(tx: Tx, shipmentId: string, lines: readonly CountedLineInput[]): Promise<string> {
  const payload = JSON.stringify(lines.map((l) => ({ line_id: l.lineId, received_quantity: l.receivedQuantity })));
  const rows = (await tx.execute(
    sql`select receive_inter_entity_shipment(${shipmentId}::uuid, ${payload}::jsonb) as received_total`,
  )) as unknown as { received_total: string }[];
  return rows[0]!.received_total;
}

export interface BuyerPostedRow {
  readonly shipmentId: string;
  readonly receivedOn: string;
  readonly postedTotal: string;
}

/** SELLER: `inter_entity_buyer_posted` - for its OWN received shipments only, exactly (shipment_id, received_on, posted_total). Nothing else of the buyer's books. */
export async function buyerPosted(tx: Tx, shipmentIds: readonly string[]): Promise<BuyerPostedRow[]> {
  if (shipmentIds.length === 0) return [];
  const ids = sql.join(
    shipmentIds.map((i) => sql`${i}::uuid`),
    sql`, `,
  );
  const rows = (await tx.execute(
    sql`select shipment_id, received_on::text as received_on, posted_total::text as posted_total from inter_entity_buyer_posted(array[${ids}]::uuid[])`,
  )) as unknown as { shipment_id: string; received_on: string; posted_total: string }[];
  return rows.map((r) => ({ shipmentId: r.shipment_id, receivedOn: r.received_on, postedTotal: r.posted_total }));
}

export interface CounterpartyBalanceRow {
  readonly counterpartyOrgId: string;
  /** What the linked organisation owes the caller (its payable to the caller's supplier row). One figure, nothing behind it. */
  readonly counterpartyOwes: string;
}

/** SELLER: `inter_entity_counterparty_balance` - one figure per linked organisation (QI-1 (a)). */
export async function counterpartyBalance(tx: Tx): Promise<CounterpartyBalanceRow[]> {
  const rows = (await tx.execute(
    sql`select counterparty_org_id, counterparty_owes::text as counterparty_owes from inter_entity_counterparty_balance()`,
  )) as unknown as { counterparty_org_id: string; counterparty_owes: string }[];
  return rows.map((r) => ({ counterpartyOrgId: r.counterparty_org_id, counterpartyOwes: r.counterparty_owes }));
}

/** SELLER: `inter_entity_counterparty_name` - the linked organisation's name for the caller's OWN customer row; null when the customer is not linked or not the caller's. */
export async function counterpartyName(tx: Tx, customerId: string): Promise<string | null> {
  const rows = (await tx.execute(
    sql`select inter_entity_counterparty_name(${customerId}::uuid) as name`,
  )) as unknown as { name: string | null }[];
  return rows[0]?.name ?? null;
}

export interface SystemBillInput {
  readonly shipmentId: string;
  readonly storeId: string;
  readonly supplierId: string;
  /** YYYY-MM-DD. */
  readonly invoiceDate: string;
  readonly dueDate: string | null;
  readonly notes: string | null;
}

/**
 * BUYER, in the receive transaction: `create_system_supplier_invoice` - the verified, system-made supplier bill for a RECEIVED shipment (QI-2 = A).
 * The total is the shipment's received_total (taken by the database, never passed in); the flag and the link are written only by this function.
 */
export async function createSystemSupplierInvoice(tx: Tx, input: SystemBillInput): Promise<string> {
  const rows = (await tx.execute(
    sql`select create_system_supplier_invoice(${input.shipmentId}::uuid, ${input.storeId}::uuid, ${input.supplierId}::uuid, ${input.invoiceDate}::date, ${input.dueDate}::date, ${input.notes}) as id`,
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}
