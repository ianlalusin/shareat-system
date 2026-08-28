/**
 * The item master, and the lines that make up a supplier invoice. T-145.
 *
 * ## ⭐ Why this table is ORG-level when v1's is per-store
 *
 * Ian, 2026-08-28: *"yes, i want to track item prices over time."* Measured against v1's live
 * data, that is impossible on its shape: **842 item records across six stores, but only 385
 * distinct names** — 187 of them existing in more than one store as separate documents with
 * separate ids, separate costs, and sometimes separate units. `white onion` is ₱61/kg at Lipa,
 * ₱130/kg at Malvar, and priced in **pcs** at Padre Garcia. A price chart over that has nothing
 * to group by, and averaging it is worse than not drawing it.
 *
 * ## ⛔ There is no stored cost here, and there never will be
 *
 * v1 has `costPerUnit` on every item. It is **zero on 595 of 842 items (71%)** — a snapshot
 * nobody maintained, which is DEF-075's pattern for the seventh time. Cost is derived from
 * `supplierInvoiceLines` (`repo/items.ts`'s `priceHistory`), so it cannot go stale.
 *
 * ## ⚠️ The one place this project deliberately STORES rather than derives
 *
 * `supplierInvoiceLines.conversionFactor` is snapshotted on the line, not read from the item.
 * The distinction matters and is not a contradiction: a balance is a *consequence* of facts and
 * must be recomputed, but a conversion used in a past transaction **is** a fact. If a price query
 * joined to the item for its factor, correcting a pack size next year would silently rewrite what
 * we paid last year.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { supplierInvoices } from './suppliers';

/** v1's own vocabulary, from live data: raw_material 340 · supply 207 · retail 234 ·
 *  meat_slab 17 · meat_sliced 44. The meat split is real, not decorative. */
export const ITEM_KINDS = ['raw_material', 'supply', 'retail', 'meat_slab', 'meat_sliced'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * ⛔ **Units of measure only — never containers.** v1 has 33 items whose `baseUnit` is `box` or
 * `pack`, which is a modelling error: a box is a quantity of something, not a way of measuring it.
 * Containers are PURCHASE units (below) and convert to one of these.
 */
export const BASE_UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'roll'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

/** What a supplier may bill in: any base unit, plus the containers v1's data actually uses. */
export const PURCHASE_UNITS = [...BASE_UNITS, 'box', 'pack', 'case', 'sack', 'tray', 'dozen'] as const;
export type PurchaseUnit = (typeof PURCHASE_UNITS)[number];

/** ⭐ `merged` is a third state, not a deletion — a merged item keeps pointing at its winner so
 *  every invoice line that referenced it still resolves, and so the duplicate's existence stays
 *  visible to whoever investigates a price anomaly later. */
export const ITEM_STATUSES = ['active', 'inactive', 'merged'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Short human key — `PORK-BELLY`. Unique per org. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ITEM_KINDS }).notNull(),
    /** ⭐ The canonical unit every price is normalised to before it is compared. */
    baseUnit: text('base_unit', { enum: BASE_UNITS }).notNull(),
    status: text('status', { enum: ITEM_STATUSES }).notNull().default('active'),
    /**
     * ⭐ **What this item may be bought and sold as — three INDEPENDENT facts** (T-149).
     *
     * Not an enum, because most items are sold to nobody and an enum has nowhere to put them:
     *
     * | | retail | wholesale | purchasable |
     * |---|---|---|---|
     * | Samgyup bento box | ✅ | ⛔ | ⛔ — we make it |
     * | Beef Premium 5kg pack | ⛔ | ✅ | ✅ |
     * | Milkis | ✅ | ✅ | ✅ |
     * | Charcoal, gloves, tissue | ⛔ | ⛔ | ✅ |
     *
     * Same shape as Odoo's "Can be Sold" / "Can be Purchased", which keeps ONE product master
     * across channels rather than a product per channel.
     */
    isPurchasable: boolean('is_purchasable').notNull().default(true),
    /** À la carte: dine-in, take-out, online. ⚠️ POS owns the menu; this is the ERP's statement
     *  of intent, which POS reads — never a second copy of POS's product list. */
    sellableRetail: boolean('sellable_retail').notNull().default(false),
    /** A franchisee or external buyer. Enforced at `setPrice`: no wholesale rate without it. */
    sellableWholesale: boolean('sellable_wholesale').notNull().default(false),
    /**
     * ⭐ T-151. Price this item off ANOTHER item's cost — v1's `costBasisProductId`. Sliced meat
     * prices off its source slab, because the slab is what was actually bought and so is the only
     * thing with a real received cost. Resolved first, before this item's own history.
     */
    costBasisItemId: uuid('cost_basis_item_id'),
    /** Set together with `status = 'merged'` — the DB refuses one without the other. */
    mergedIntoId: uuid('merged_into_id'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('items_org_code_key').on(t.orgId, t.code),
    /** ⛔ "Pork Belly" and "pork belly" are ONE thing — case-insensitive, because 187
     *  duplicate names across v1's stores is exactly how a price chart stops summing. */
    uniqueIndex('items_org_name_key').on(t.orgId, sql`lower(${t.name})`),
    index('items_org_status_idx').on(t.orgId, t.status),
    check('items_code_not_blank_check', sql`length(trim(${t.code})) > 0`),
    check('items_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
  ],
);

export const supplierInvoiceLines = pgTable(
  'supplier_invoice_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    supplierInvoiceId: uuid('supplier_invoice_id')
      .notNull()
      // A line is genuinely part of its invoice, not a record that could outlive it.
      .references(() => supplierInvoices.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** What the supplier called it, verbatim. Kept because the paper says what the paper says,
     *  and renaming the item must not rewrite a past bill. */
    description: text('description'),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** The unit the supplier actually billed in — may be a container. */
    purchaseUnit: text('purchase_unit', { enum: PURCHASE_UNITS }).notNull(),
    /**
     * ⭐ **Snapshotted, never looked up later.** See this file's header: correcting a pack size
     * next year must not rewrite what a past invoice says we paid.
     */
    conversionFactor: numeric('conversion_factor', { precision: 14, scale: 6 }).notNull(),
    /** Per PURCHASE unit, as billed. ₱ per base unit is derived, never typed. */
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('supplier_invoice_lines_invoice_line_key').on(t.supplierInvoiceId, t.lineNo),
    index('supplier_invoice_lines_item_idx').on(t.itemId),
  ],
);

export const ITEM_REQUEST_STATUSES = ['requested', 'approved', 'rejected'] as const;
export type ItemRequestStatus = (typeof ITEM_REQUEST_STATUSES)[number];

/**
 * ⭐ Everyone below super-admin ASKS for an item; a super-admin decides. Ian, 2026-08-28.
 *
 * Fuzzy matching degrades as a catalogue grows — a 0.5 similarity floor that separates 385 names
 * cleanly will produce noise at 3,000. A human reviewing every addition does not degrade, which is
 * why the approval is the strong control and the trigram check is only the assistant that makes
 * the human's job possible.
 */
export const itemRequests = pgTable(
  'item_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    kind: text('kind', { enum: ITEM_KINDS }).notNull(),
    baseUnit: text('base_unit', { enum: BASE_UNITS }).notNull(),
    reason: text('reason'),
    status: text('status', { enum: ITEM_REQUEST_STATUSES }).notNull().default('requested'),
    /** ⚠️ Frozen at request time. Recomputing at approval would answer a different question — the
     *  catalogue moves — and the approver needs to see what the requester was shown. */
    similarWarning: text('similar_warning'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => persons.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdItemId: uuid('created_item_id').references(() => items.id, { onDelete: 'restrict' }),
  },
  (t) => [index('item_requests_org_status_idx').on(t.orgId, t.status)],
);

/**
 * ⭐ Where ONE store's answer differs from the org's. T-149, Ian 2026-08-28: *"it must be store
 * scoped coz the main branch shareat lipa might be making the bulgogi sauce but the franchisee is
 * purchasing it from shareat lipa."*
 *
 * ⛔ **This is not a per-store item master, and the difference is the whole point.** Bulgogi sauce
 * is ONE `items` row — one identity, one price history, org-wide. What varies by store is what
 * that store DOES with it. v1 stored the item itself per store and produced 842 records for 385
 * real products; the moment this table grows a name or a unit, it has become that.
 *
 * ⚠️ Every column is NULLABLE, meaning *"no opinion — use the org default"*. A store overriding
 * only `isPurchasable` must not be made to restate the other two, because restating them freezes
 * today's default into a copy that stops tracking it.
 */
export const storeItemSellability = pgTable(
  'store_item_sellability',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    isPurchasable: boolean('is_purchasable'),
    sellableRetail: boolean('sellable_retail'),
    sellableWholesale: boolean('sellable_wholesale'),
    note: text('note'),
    setBy: uuid('set_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('store_item_sellability_store_item_key').on(t.storeId, t.itemId),
    index('store_item_sellability_org_item_idx').on(t.orgId, t.itemId),
  ],
);

export const PRICING_MODES = ['fixed', 'fixed_markup', 'percent_markup'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/**
 * ⭐ How an item's branch price is worked out. T-151, ported from v1's `computeBranchPrice`.
 *
 * | Mode | Price |
 * |---|---|
 * | `fixed` | a set peso amount |
 * | `fixed_markup` | basis + peso amount |
 * | `percent_markup` | basis × (1 + markup%) |
 *
 * ⛔ **There is no cost column here, deliberately.** v1 stores a rolling `lastReceivedCost`, and
 * that is exactly what broke: a delivery line entered as qty 1 with the lot TOTAL in the unit-cost
 * field poisoned it, and because the basis rule is `max(prior, new)` the poison was STICKY —
 * every later, cheaper receive kept it, freezing a chopstick branch price at ₱1,458 instead of
 * ₱1.46. Correcting the delivery did not fix it either: the refresh skips recompute when the
 * stored value already equals the new max, so it could not self-heal.
 *
 * ⭐ v2 derives the basis from invoice history on every read. Fix the bad line, and the price is
 * right the next time anyone asks for it.
 */
export const itemPricing = pgTable(
  'item_pricing',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    pricingMode: text('pricing_mode', { enum: PRICING_MODES }).notNull(),
    fixedAmount: numeric('fixed_amount', { precision: 14, scale: 2 }),
    markupPercent: numeric('markup_percent', { precision: 8, scale: 4 }),
    fixedMarkupAmount: numeric('fixed_markup_amount', { precision: 14, scale: 2 }),
    /** ⚠️ Advisory. It warns; it never blocks an order. */
    marginAlertThresholdPct: numeric('margin_alert_threshold_pct', { precision: 8, scale: 4 }),
    setBy: uuid('set_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('item_pricing_item_key').on(t.itemId),
    index('item_pricing_org_idx').on(t.orgId),
  ],
);
