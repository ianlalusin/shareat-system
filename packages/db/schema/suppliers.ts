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
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { storedFiles } from './stored-files';
import { stores } from './stores';

export const SUPPLIER_STATUSES = ['active', 'inactive'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_VAT_STATUSES = ['vat_registered', 'non_vat'] as const;
export type SupplierVatStatus = (typeof SUPPLIER_VAT_STATUSES)[number];

export const SUPPLIER_INVOICE_STATUSES = ['pending', 'verified', 'voided'] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

/**
 * v1's `classification`, ported as a LABEL. T-188 §4.2.
 *
 * ⚠️ **96% filled in v1 and it drives NOTHING there** — the editor writes it, the action saves
 * it, and no code reads it for a decision. (Every `classification` that *does* branch in v1 belongs
 * to `ARCustomerClassification`, a different entity with the same word.)
 *
 * ⛔ So nothing here may branch on it either, until somebody decides what it means. The natural
 * future use is the BIR expanded-withholding split — individuals and corporations attract
 * different EWT rates — and that is deliberately NOT built.
 */
export const SUPPLIER_CLASSIFICATIONS = ['corporate', 'individual', 'other'] as const;
export type SupplierClassification = (typeof SUPPLIER_CLASSIFICATIONS)[number];

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
     * T-398 S5 (migration 0218) adds the stated need: `counterpartyOrgId` below.
     */
    counterpartyStoreId: uuid('counterparty_store_id').references(() => stores.id, {
      onDelete: 'restrict',
    }),
    /**
     * T-398 S5 (migration 0218) - Padre Garcia's supplier row for the commissary: the OTHER organisation this supplier is. At most one of
     * `counterpartyStoreId` / `counterpartyOrgId` (`suppliers_one_counterparty_check`). System-set when an inter-entity shipment is received.
     */
    counterpartyOrgId: uuid('counterparty_org_id').references(() => organizations.id, {
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

    // ---- T-188. Every one of these was measured against the live v1 data before being added;
    // the fields that were NOT added (paymentOptions, contactNo2, logoPath, lastCreditDueDays)
    // are recorded in the task doc with their fill rates. ⛔ Do not "complete" the port.
    email: text('email'),
    representativeName: text('representative_name'),

    /** v1's `vatRegistrationNo`. ⚠️ **Renamed on purpose** — in the Philippines this IS the TIN,
     *  and `vat_registration_no` sitting beside `vat_status` reads like a second status field. */
    tin: text('tin'),

    /** ⚠️ A LABEL, not a rule. See `SUPPLIER_CLASSIFICATIONS` — nothing may branch on it. */
    classification: text('classification', { enum: SUPPLIER_CLASSIFICATIONS }),

    /**
     * ⭐ The one v1 field that actually does work: it DEFAULTS the document type when an invoice
     * is logged against this supplier (v1 `receipt-editor.tsx:188`).
     *
     * ⛔ It is a default and nothing more. `supplier_invoices.is_official_receipt` holds what the
     * document actually WAS, and the two are allowed to disagree — changing a supplier's habit
     * today must never rewrite what last month's receipt was.
     */
    issuesOfficialReceipt: boolean('issues_official_receipt').notNull().default(true),

    /**
     * ⭐ **Does this supplier extend credit, and on what terms?** T-266 §5, migration 0141.
     *
     * `NULL` means **cash on delivery** — the money form offers *Credit (AP)* but disables it and
     * names the supplier in the reason. A number means credit is accepted, and it is the default
     * due date: `invoice_date + N days`.
     *
     * ⭐ ONE nullable integer answers both *"may we?"* and *"due when?"*, which is why it is not a
     * boolean beside a days column — those two can disagree (accepts_credit true with null days),
     * and nothing downstream could tell which was meant.
     *
     * ⚠️ **This models something v1 could not ask at all.** v1's `SupplierPlain.paymentOptions`
     * is a comma-separated free-text list, written by one editor and read by exactly one details
     * page that prints it — no logic anywhere consults it. v1's only real credit check is *"a
     * supplier is selected"*. So this is designed, not ported (bible §1.2d): the v1 field is
     * evidence of the NEED and nothing more.
     */
    creditTermsDays: integer('credit_terms_days'),

    /**
     * ⚠️ Three COLUMNS, not a child table, and the live data is why: **5 of 129 suppliers have
     * bank details, and every one of them has exactly ONE account.** Odoo and ERPNext both use a
     * child table because their users bank with several institutions; ours do not.
     *
     * `bankName` is deliberately free text so an e-wallet (GCash, Maya) fits without a second
     * concept — which is what v1's unused `providerName` key was groping towards.
     *
     * ⭐ If a supplier ever genuinely needs two, THAT is the moment to add the table.
     */
    bankName: text('bank_name'),
    bankAccountName: text('bank_account_name'),
    bankAccountNumber: text('bank_account_number'),

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
    index('suppliers_counterparty_org_idx').on(t.counterpartyOrgId),
    // NOTE: suppliers_one_counterparty_check CHECK (num_nonnulls(counterparty_store_id, counterparty_org_id) <= 1) - hand-added in migration 0218 (T-398 S5).
    uniqueIndex('suppliers_org_name_key').on(t.orgId, t.name),

    check('suppliers_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('suppliers_status_check', sql`${t.status} in ('active','inactive')`),
    /** T-367 S3 (DEF-500): NULL = cash on delivery, else 0..365 days. In the database since migration 0141; declared
     *  here so the schema and the database agree (a regenerated schema would otherwise drop it). The name is
     *  byte-equal to the migration's. */
    check(
      'suppliers_credit_terms_days_check',
      sql`${t.creditTermsDays} is null or (${t.creditTermsDays} >= 0 and ${t.creditTermsDays} <= 365)`,
    ),
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
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.counterpartyStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'suppliers_counterparty_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'suppliers_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.reconciledBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'suppliers_reconciled_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: suppliers_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES suppliers (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
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
    /**
     * ⭐ T-151. Inbound freight — supplier to us. Ian, 2026-08-28: *"delivery fee from supplier to
     * Lipa is added to price."* It is part of what the goods cost to have, so it is allocated
     * across the lines by value and raises every landed cost on this invoice.
     *
     * ⚠️ The line-sum rule moves with it: `sum(lines) + delivery_fee + other_fees = total_amount`.
     */
    deliveryFee: numeric('delivery_fee', { precision: 14, scale: 2 }).notNull().default('0'),
    otherFees: numeric('other_fees', { precision: 14, scale: 2 }).notNull().default('0'),
    notes: text('notes'),

    status: text('status', { enum: SUPPLIER_INVOICE_STATUSES }).notNull().default('pending'),

    /**
     * ⭐ **The evidence, and the ONLY form of it** (DEF-055, relocated here from `expenses`).
     *
     * ⛔ `receiptPhotoUrl` was dropped at migration 0046. It was plain text, so a typed `x`
     * satisfied it, and `verifyInvoice` fell through to it whenever no file was named — which the
     * AP form guaranteed, since it only ever offered a text box. A brokered file row cannot be
     * forged: its path is derived server-side from the session (T-141), and this column now
     * carries a real FK proving the row exists. Still nullable, because the commissary-mirror
     * exemption is a service-layer rule (a CHECK cannot join out to `suppliers` to test it).
     */
    receiptFileId: uuid('receipt_file_id').references(() => storedFiles.id, { onDelete: 'restrict' }),

    /**
     * ⛔ **Cannot be whoever created the invoice** — `supplier_invoices_two_person_verification_check`
     * (migration 0046). Standard AP segregation of duties, and a v2 correction rather than a port:
     * in v1's live data 577 of 1,324 verified receipts (44%) were verified by the person who
     * submitted them, because v1's policy checks role and never identity.
     */
    verifiedBy: uuid('verified_by').references(() => persons.id, { onDelete: 'restrict' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    /**
     * ⭐ **What "verified" actually means** — Ian, 2026-08-28: *"right supplier, right invoice
     * data, right items, right price all verified plus an uploaded photo."* Four confirmations,
     * so four columns: one boolean cannot say WHICH of the four a person actually checked, and
     * being specific is the entire point of an attestation.
     *
     * ⚠️ `attestedItems`/`attestedPrice` are a human's confirmation against the photo today —
     * there are no invoice lines yet to check against. When the item master lands they become
     * machine-checkable too; these columns do not change, the evidence behind them gets stronger.
     */
    attestedSupplier: boolean('attested_supplier').notNull().default(false),
    attestedInvoice: boolean('attested_invoice').notNull().default(false),
    attestedItems: boolean('attested_items').notNull().default(false),
    attestedPrice: boolean('attested_price').notNull().default(false),

    /**
     * T-475 S3 (migration 0217). True when the person who logged this invoice verified it themselves, which only a holder of
     * `verify_own_supplier_invoice` (admin / super_admin by ROLE) may do. History: set once with the verification, never cleared
     * (trigger `supplier_invoices_self_verified_immutable`, ENABLE ALWAYS). The domain sets it from `can()` and nothing else.
     */
    // NOTE: the column's checks, index and both triggers are hand-added in migration 0217 (see the NOTEs at the foot of this table).
    selfVerified: boolean('self_verified').notNull().default(false),

    /** Real, server-recomputed VAT (v1: `receipt.actions.ts:283-325`), captured as data. Not yet
     *  posted to a separate input-VAT account — no split exists in `POSTING-PATTERNS.md` today. */
    /**
     * ⭐ T-188. What THIS document was, copied from the supplier's habit at creation and owned by
     * the invoice thereafter. ⛔ Never read through to `suppliers.issues_official_receipt` — a BIR
     * audit asks what the receipt was, not what the supplier usually issues.
     */
    isOfficialReceipt: boolean('is_official_receipt').notNull().default(true),

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
    check('supplier_invoices_total_amount_finite_check', sql`${t.totalAmount} > '-Infinity'::numeric and ${t.totalAmount} < 'Infinity'::numeric`),
    check('supplier_invoices_delivery_fee_finite_check', sql`${t.deliveryFee} > '-Infinity'::numeric and ${t.deliveryFee} < 'Infinity'::numeric`),
    check('supplier_invoices_other_fees_finite_check', sql`${t.otherFees} > '-Infinity'::numeric and ${t.otherFees} < 'Infinity'::numeric`),
    check('supplier_invoices_vat_rate_finite_check', sql`${t.vatRate} > '-Infinity'::numeric and ${t.vatRate} < 'Infinity'::numeric`),
    check('supplier_invoices_vat_amount_finite_check', sql`${t.vatAmount} > '-Infinity'::numeric and ${t.vatAmount} < 'Infinity'::numeric`),
    check('supplier_invoices_vat_exclusive_amount_finite_check', sql`${t.vatExclusiveAmount} > '-Infinity'::numeric and ${t.vatExclusiveAmount} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'supplier_invoices_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'supplier_invoices_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.verifiedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'supplier_invoices_verified_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'supplier_invoices_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `receipt_file_id` FK (RLS checks only this row's org_id); references `stored_files_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.receiptFileId],
      foreignColumns: [storedFiles.orgId, storedFiles.id],
      name: 'supplier_invoices_receipt_file_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `supplier_id` FK (RLS checks only this row's org_id); references `suppliers_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
      name: 'supplier_invoices_supplier_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: hand-added in 0217 (T-475 S3), no Drizzle mirror: `supplier_invoices_two_person_verification_check` (from 0046) is REPLACED under the
    // same name by CHECK (verified_by IS NULL OR verified_by <> created_by OR self_verified) NOT VALID; `supplier_invoices_self_verified_means_self_check`
    // CHECK (NOT self_verified OR verified_by = created_by) (added NOT VALID, then VALIDATED); partial index `supplier_invoices_self_verified_idx`
    // ON (org_id, verified_at) WHERE self_verified; triggers `supplier_invoices_self_verify_requires_capability` (validator) and
    // `supplier_invoices_self_verified_immutable` (history_guard, ENABLE ALWAYS). Do not "fix" the builder to match.
    // NOTE: supplier_invoices_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES supplier_invoices (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);
