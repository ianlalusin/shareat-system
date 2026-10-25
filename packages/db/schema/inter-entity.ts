/**
 * T-398 S5 (migration 0218) - the inter-entity shipment: the ONE defined cross-organisation handoff (Padre Garcia).
 * docs/tasks/398-padre-garcia-franchise-org.md section 0b + S5, docs/tasks/398-s5/S5-REFRESH.md section 3.
 *
 * The commissary (org_id) writes a shipment note in the same transaction as its sale; the franchise (buyer_org_id) may READ it and
 * stamp "received" through receive_inter_entity_shipment(). Nothing else crosses: the snapshot carries NO cost, NO layer, NO person name.
 * RLS scope 'dual_org_counterparty' (rls/registry.ts): SELECT admits org_id OR buyer_org_id; INSERT / UPDATE admit org_id only; no DELETE.
 *
 * Everything the model cannot express is hand-added in migration 0218 (see the NOTE comments): the UNIQUE keys, the CHECKs, the policies, the
 * link trigger inter_entity_shipments_link_check_trg, and the three SECURITY DEFINER functions.
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { tradeOrderLines, tradeOrders } from './trade';

export const INTER_ENTITY_SHIPMENT_STATUSES = ['in_transit', 'received', 'void'] as const;
export type InterEntityShipmentStatus = (typeof INTER_ENTITY_SHIPMENT_STATUSES)[number];

export const interEntityShipments = pgTable(
  'inter_entity_shipments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** The SELLER (the commissary). */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The BUYER (the franchise). CHECK buyer_org_id <> org_id. */
    buyerOrgId: uuid('buyer_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** One shipment per order (UNIQUE, A4): a retried dispatch cannot write a second. */
    tradeOrderId: uuid('trade_order_id').notNull(),
    storeId: uuid('store_id').notNull(),
    shippedOn: date('shipped_on').notNull(),
    birInvoiceNo: text('bir_invoice_no'),
    billedTotal: numeric('billed_total', { precision: 14, scale: 2 }).notNull(),
    /** What the commissary has credited back after a short receipt (S5e). 0 <= credited_total <= billed_total. */
    creditedTotal: numeric('credited_total', { precision: 14, scale: 2 }).notNull().default('0'),
    status: text('status', { enum: INTER_ENTITY_SHIPMENT_STATUSES }).notNull().default('in_transit'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    /** A person of the BUYER organisation: (buyer_org_id, received_by) -> persons (org_id, id). */
    receivedBy: uuid('received_by'),
    receivedTotal: numeric('received_total', { precision: 14, scale: 2 }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by'),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('inter_entity_shipments_org_status_idx').on(t.orgId, t.status, t.shippedOn),
    index('inter_entity_shipments_buyer_status_idx').on(t.buyerOrgId, t.status, t.shippedOn),
    check('inter_entity_shipments_buyer_differs_check', sql`${t.buyerOrgId} <> ${t.orgId}`),
    check('inter_entity_shipments_status_check', sql`${t.status} in ('in_transit', 'received', 'void')`),
    // NOTE: UNIQUE (trade_order_id), UNIQUE (org_id, id), UNIQUE (buyer_org_id, id), UNIQUE (org_id, buyer_org_id, id) - hand-added in migration 0218 (T-398 S5), no Drizzle mirror here.
    // NOTE: the money, received-shape and void-shape CHECKs (billed_total > 0, 0 <= credited_total <= billed_total, status <-> received_* all-or-none, status <-> void_* all-or-none) - hand-added in migration 0218.
    // NOTE: RLS (ENABLE + FORCE; SELECT org_id OR buyer_org_id, INSERT / UPDATE org_id only, no DELETE), the grants, trigger inter_entity_shipments_link_check_trg and the three SECURITY DEFINER functions - hand-added in migration 0218.
    foreignKey({
      columns: [t.orgId, t.tradeOrderId],
      foreignColumns: [tradeOrders.orgId, tradeOrders.id],
      name: 'inter_entity_shipments_trade_order_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'inter_entity_shipments_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'inter_entity_shipments_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // The declared cross-organisation shape (A6): the receiver is checked against the BUYER organisation.
    foreignKey({
      columns: [t.buyerOrgId, t.receivedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'inter_entity_shipments_received_by_buyer_org_fk',
    }).onDelete('restrict'),
  ],
);

export const interEntityShipmentLines = pgTable(
  'inter_entity_shipment_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    buyerOrgId: uuid('buyer_org_id').notNull(),
    shipmentId: uuid('shipment_id').notNull(),
    tradeOrderLineId: uuid('trade_order_line_id').notNull(),
    lineNo: integer('line_no').notNull(),
    /** The line SNAPSHOT: name, unit, quantity, rate, line total. No cost, no layer, no person name (E24). */
    itemName: text('item_name').notNull(),
    unit: text('unit').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
    /** QI-1 (a): what the buyer counted at the door, stamped by receive_inter_entity_shipment(). NULL until received. */
    receivedQuantity: numeric('received_quantity', { precision: 14, scale: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NOTE: UNIQUE (shipment_id, line_no), UNIQUE (org_id, id), receipt-guard triggers on both tables and the CHECKs (quantity > 0, rate >= 0, line_total = round(quantity * rate, 2), 0 <= received_quantity <= quantity) - hand-added in migration 0218 (T-398 S5).
    // NOTE: RLS (ENABLE + FORCE; SELECT org_id OR buyer_org_id, INSERT / UPDATE org_id only, no DELETE) and the grants - hand-added in migration 0218.
    foreignKey({
      columns: [t.orgId, t.buyerOrgId, t.shipmentId],
      foreignColumns: [interEntityShipments.orgId, interEntityShipments.buyerOrgId, interEntityShipments.id],
      name: 'inter_entity_shipment_lines_shipment_same_pair_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.tradeOrderLineId],
      foreignColumns: [tradeOrderLines.orgId, tradeOrderLines.id],
      name: 'inter_entity_shipment_lines_trade_order_line_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
