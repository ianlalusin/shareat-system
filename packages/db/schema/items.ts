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

export const ITEM_STATUSES = ['active', 'inactive'] as const;
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
