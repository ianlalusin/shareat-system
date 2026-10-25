/**
 * The inter-entity shipment's SQL - T-398 S5 (migration 0218). The only place these rows are read or written.
 *
 * ## The one defined cross-organisation handoff
 *
 * The commissary (the SELLER, `org_id`) writes a shipment note in the same transaction as its sale. The franchise (the BUYER,
 * `buyer_org_id`) may READ it and stamp "received" through {@link receive}, the only thing the buyer ever writes into the seller's table.
 * The three SECURITY DEFINER functions are called here and nowhere else (RULES: SQL lives in the repo).
 *
 * - Seller functions run under the seller's principal: {@link create}, {@link findByTradeOrder}, {@link linesOf}, {@link markVoid},
 *   {@link buyerPosted}, {@link counterpartyBalance}.
 * - Buyer functions run under the buyer's principal: {@link listInbound}, {@link findById}, {@link receive}.
 *
 * Money is `numeric`, never float: every amount in and out is a decimal string (a branded `Money` / `Quantity` going in).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { interEntityShipmentLines, interEntityShipments, type InterEntityShipmentStatus } from '../../schema/inter-entity';
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

/** Either side (RLS admits the seller and the buyer): one shipment by id. */
export async function findById(tx: Tx, id: string): Promise<InterEntityShipmentRow | null> {
  const [row] = await tx.select(SHIPMENT_COLUMNS).from(interEntityShipments).where(eq(interEntityShipments.id, id));
  return row ?? null;
}

/** Either side: the lines of one shipment in line order. */
export async function linesOf(tx: Tx, shipmentId: string): Promise<InterEntityShipmentLineRow[]> {
  return tx.select(LINE_COLUMNS).from(interEntityShipmentLines).where(eq(interEntityShipmentLines.shipmentId, shipmentId)).orderBy(asc(interEntityShipmentLines.lineNo));
}

/** BUYER: the shipments addressed to `buyerOrgId`, newest first. Voided ones are left out unless `includeVoid`. */
export async function listInbound(
  tx: Tx,
  buyerOrgId: string,
  opts: { status?: InterEntityShipmentStatus; includeVoid?: boolean } = {},
): Promise<InterEntityShipmentRow[]> {
  const conds = [eq(interEntityShipments.buyerOrgId, buyerOrgId)];
  if (opts.status) conds.push(eq(interEntityShipments.status, opts.status));
  else if (!opts.includeVoid) conds.push(inArray(interEntityShipments.status, ['in_transit', 'received']));
  return tx
    .select(SHIPMENT_COLUMNS)
    .from(interEntityShipments)
    .where(and(...conds))
    .orderBy(desc(interEntityShipments.shippedOn), desc(interEntityShipments.id));
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
