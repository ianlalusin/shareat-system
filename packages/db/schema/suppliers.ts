/**
 * Suppliers and supplier invoices. T-130.
 *
 * ## ⛔ `outstanding_balance` — DEF-075, refused before it is written
 *
 * v1's `SupplierPlain.outstandingBalance` is the same stored-balance defect found five times
 * already (loans, owner equity, cash requests, liabilities, customers). Here the balance is
 * summed from `2110` by party, same as every control account since T-118.
 *
 * ## ⭐ `supplier_invoices` is the gate, not `expenses`
 *
 * ⚠️ **Corrected 2026-08-27, by Ian, directly, twice** (docs/tasks/130-accounts-payable.md §2's
 * own history). No expense — cash or credit — may be recorded until its `supplier_invoices` row
 * is `verified`, ported from v1's real `pending → verified` receipt lifecycle
 * (`receipt.actions.ts`, `verifyReceiptAction`), not a re-derived approximation of it. The gate
 * is enforced by a hand-written trigger on `expenses` (migration, DEF-073), because `db:generate`
 * cannot produce one and this rule has to hold regardless of which code path writes the row —
 * same reasoning as T-118's `journal_lines_check_party_requirement`.
 *
 * VAT fields on the invoice are real and active in v1 (server-recomputed from the supplier's own
 * registration status, `receipt.actions.ts:283-325`), captured here for the data, not yet posted
 * to a separate input-VAT account — that split does not exist anywhere in this schema today.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
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

export const SUPPLIER_STATUSES = ['active', 'inactive'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_VAT_STATUSES = ['vat_registered', 'non_vat'] as const;
export type SupplierVatStatus = (typeof SUPPLIER_VAT_STATUSES)[number];

export const SUPPLIER_INVOICE_STATUSES = ['pending', 'verified', 'voided'] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

export const SUPPLIER_INVOICE_VAT_TYPES = ['vatable', 'zero_rated', 'exempt', 'non_vat'] as const;
export type SupplierInvoiceVatType = (typeof SUPPLIER_INVOICE_VAT_TYPES)[number];

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    address: text('address'),
    contactNo: text('contact_no'),

    /**
     * ⭐ **System-managed only** — v1's `SupplierPlain.linkedStoreId` comment: *"Created
     * automatically when the commissary admin sets `linkedStoreId` on the AR customer... locked
     * down to system writes only."* Surfaced read-only on the ordinary supplier form; the write
     * path belongs to `customers`/T-129, not this task.
     *
     * ⛔ No `counterpartyOrgId` twin — v1's `SupplierPlain` has no cross-org link (unlike
     * `customers`'s franchise case). Not added without a stated need (bible §16.4).
     */
    counterpartyStoreId: uuid('counterparty_store_id').references(() => stores.id, {
      onDelete: 'restrict',
    }),

    /**
     * ⚠️ Coupled to the invoice's own VAT fields, not independently meaningful. v1 refuses VAT
     * fields on a receipt outright when the supplier is not VAT-registered
     * (`receipt.actions.ts:299-310`) rather than silently zeroing them — the same discipline
     * `supplierInvoices`'s own CHECK below applies.
     */
    vatStatus: text('vat_status', { enum: SUPPLIER_VAT_STATUSES }),

    status: text('status', { enum: SUPPLIER_STATUSES }).notNull().default('active'),
    notes: text('notes'),

    reconciledAsOf: date('reconciled_as_of'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    reconciledBy: uuid('reconciled_by').references(() => persons.id, { onDelete: 'restrict' }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('suppliers_org_idx').on(t.orgId),
    index('suppliers_counterparty_store_idx').on(t.counterpartyStoreId),
    uniqueIndex('suppliers_org_name_key').on(t.orgId, t.name),

    check('suppliers_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('suppliers_status_check', sql`${t.status} in ('active','inactive')`),
    check(
      'suppliers_vat_status_check',
      sql`${t.vatStatus} is null or ${t.vatStatus} in ('vat_registered','non_vat')`,
    ),
    /** An anchor is a three-part fact — same shape as `customers.customers_reconciled_shape_check`. */
    check(
      'suppliers_reconciled_shape_check',
      sql`(${t.reconciledAsOf} is null and ${t.reconciledAt} is null and ${t.reconciledBy} is null)
          or (${t.reconciledAsOf} is not null and ${t.reconciledAt} is not null
              and ${t.reconciledBy} is not null)`,
    ),
  ],
);

export const supplierInvoices = pgTable(
  'supplier_invoices',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),

    /** Supplier's own reference. Nullable — not every purchase carries one (v1's `receiptNo`
     *  is optional too). Read by the warn-only duplicate check, never a unique constraint
     *  (bible §16.10: a corrected re-entry of the same number is a real, legitimate case). */
    invoiceNo: text('invoice_no'),
    invoiceDate: date('invoice_date').notNull(),
    /** Typed and real, nullable. v1's equivalent is read via `(expense as any).dueDate` — an
     *  untyped, unreliable field this column replaces, not carries forward. Aging falls back
     *  to `invoiceDate` when this is null (informal supplier terms are real). */
    dueDate: date('due_date'),

    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    notes: text('notes'),

    status: text('status', { enum: SUPPLIER_INVOICE_STATUSES }).notNull().default('pending'),

    /** The evidence — required to reach `verified` (service-layer rule; a CHECK constraint
     *  cannot safely join out to `suppliers` to test the commissary exemption). Relocated
     *  from `expenses.receiptPhotoUrl`/`receiptFileId` (DEF-055). */
    receiptPhotoUrl: text('receipt_photo_url'),
    receiptFileId: uuid('receipt_file_id'),

    verifiedBy: uuid('verified_by').references(() => persons.id, { onDelete: 'restrict' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    /** Real, server-recomputed VAT (v1: `receipt.actions.ts:283-325`), captured as data. Not yet
     *  posted to a separate input-VAT account — no split exists in `POSTING-PATTERNS.md` today. */
    vatType: text('vat_type', { enum: SUPPLIER_INVOICE_VAT_TYPES }),
    vatRate: numeric('vat_rate', { precision: 8, scale: 4 }),
    vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }),
    vatExclusiveAmount: numeric('vat_exclusive_amount', { precision: 14, scale: 2 }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),

    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('supplier_invoices_org_idx').on(t.orgId),
    index('supplier_invoices_supplier_idx').on(t.supplierId),
    index('supplier_invoices_org_status_idx').on(t.orgId, t.status),
    index('supplier_invoices_org_due_date_idx').on(t.orgId, t.dueDate),

    check('supplier_invoices_total_positive_check', sql`${t.totalAmount} > 0`),
    check(
      'supplier_invoices_status_check',
      sql`${t.status} in ('pending','verified','voided')`,
    ),
    check(
      'supplier_invoices_vat_type_check',
      sql`${t.vatType} is null or ${t.vatType} in ('vatable','zero_rated','exempt','non_vat')`,
    ),
    /** ⚠️ ONE-DIRECTIONAL on purpose, unlike suppliers' reconciled-shape CHECK: reaching
     *  'verified' REQUIRES the anchor, but voiding a PREVIOUSLY-verified invoice must not force
     *  it to be cleared — the stamp is history ("this was verified, by whom"), not a fact only
     *  true while status = 'verified'. A biconditional here rejected every void of an
     *  already-verified invoice outright (caught by this task's own void-cascade test). */
    check(
      'supplier_invoices_verified_shape_check',
      sql`${t.status} <> 'verified' or (${t.verifiedBy} is not null and ${t.verifiedAt} is not null)`,
    ),
    /** All-or-nothing, the shape every other termination in this schema uses. */
    check(
      'supplier_invoices_void_shape_check',
      sql`${t.status} <> 'voided'
          or (${t.voidedBy} is not null and ${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
  ],
);
