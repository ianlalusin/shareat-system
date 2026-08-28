/**
 * The supplier-item catalogue — **declarations only**. T-147.
 *
 * ## ⭐ Why this table is half the size the spec first proposed
 *
 * "Who sells what" has two kinds of answer, and only one of them is a fact needing storage:
 *
 * | | Where it comes from | Stored? |
 * |---|---|---|
 * | **observed** — this supplier has billed us this item | `SELECT DISTINCT` over `supplier_invoice_lines` | ⛔ No — it is a query |
 * | **declared** — a person says we *could* buy this here | nothing derives it | ✅ This table |
 *
 * The first draft stored both. Storing the observed half caches something the ledger already
 * answers, which is DEF-075's pattern for the eighth time — caught by running the project's own
 * `/research-evaluate-propose` on the spec, before any code, and given away by the spec's own
 * invariant list refusing a stored *price* two lines above a stored *relationship*.
 *
 * ⭐ Everything that fell away when the observed half became a query: the `source` column, the
 * promotion step when an invoice finally proves a declaration, the "observed must never be
 * demoted" invariant, and the check stopping someone deleting an observed link. That last one is
 * now structural — *you cannot un-buy something* because an observation is not a row.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { suppliers } from './suppliers';

export const supplierItems = pgTable(
  'supplier_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    /** ⭐ NOT NULL — nothing but a person writes here, so the author is always known. */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_items_supplier_item_key').on(t.supplierId, t.itemId),
    index('supplier_items_org_idx').on(t.orgId),
    index('supplier_items_item_idx').on(t.itemId),
  ],
);

/** How a catalogue row came to be known — computed at READ time, never stored. */
export const CATALOGUE_SOURCES = ['observed', 'declared'] as const;
export type CatalogueSource = (typeof CATALOGUE_SOURCES)[number];
