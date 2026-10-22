/**
 * Accounts receivable — charges, collections, allocation, write-off. T-131.
 *
 * ## ⭐ The mirror of T-130, on purpose
 *
 * AP proved the shape: a control account, a subledger keyed by party, open items derived from the
 * ledger rather than stored, allocation that must name what it settles, and a surplus that becomes
 * a named balance instead of a floating number. AR is that machinery pointed the other way.
 *
 * ## ⛔ Four things v1 does that are refused here, each measured in its live data
 *
 * | v1 | Measured | Here |
 * |---|---|---|
 * | stored `outstandingAmount` | disagrees with its own inputs on **106 of 794 rows (13.3%)** | derived, always |
 * | `overageAsStoreCredit` | a boolean with **no balance behind it**, used **0 of 512 times** | a real `2140` liability |
 * | `unallocatedAmount` | money tied to nothing on **38 collections**, no way to re-apply | impossible — surplus posts |
 * | `pending_verification` | a status **nothing can transition out of** | not modelled |
 *
 * ⚠️ 74% of v1's "AR collections" (381 of 512) are delivery-platform settlements written through
 * a different action entirely. Those are NOT this module — see `docs/tasks/131-*.md`.
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { journalEntries } from './journal';
import { moneyAccounts } from './money-accounts';
import { organizations } from './organizations';
import { persons } from './persons';
import { storedFiles } from './stored-files';
import { stores } from './stores';

export const AR_DOC_STATUSES = ['draft', 'posted', 'voided'] as const;
export type ArDocStatus = (typeof AR_DOC_STATUSES)[number];

export const arCharges = pgTable(
  'ar_charges',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    chargeDate: date('charge_date').notNull(),
    /** Aging reads this, falling back to `chargeDate` — bible row 162. */
    dueDate: date('due_date'),
    referenceNo: text('reference_no'),
    notes: text('notes'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    /**
     * ⭐ Which income account this credit sale credits — explicit, never guessed.
     *
     * The sales-day router **refuses credit sales outright** (*"credit sales belong to AR
     * (T-131), not to a daily summary"*), so nothing else books this revenue. There is no
     * wholesale-revenue account in the chart today; naming one here keeps the choice visible
     * rather than inventing an account nobody decided on.
     */
    revenueAccountCode: text('revenue_account_code').notNull(),
    status: text('status', { enum: AR_DOC_STATUSES }).notNull().default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('ar_charges_org_customer_idx').on(t.orgId, t.customerId),
    index('ar_charges_store_idx').on(t.storeId),
    index('ar_charges_org_due_date_idx').on(t.orgId, t.dueDate),
    check('ar_charges_total_positive_check', sql`${t.totalAmount} > 0`),
    check('ar_charges_total_amount_finite_check', sql`${t.totalAmount} > '-Infinity'::numeric and ${t.totalAmount} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'ar_charges_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'ar_charges_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'ar_charges_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `customer_id` FK (RLS checks only this row's org_id); references `customers_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'ar_charges_customer_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'ar_charges_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: ar_charges_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES ar_charges (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);

export const arCollections = pgTable(
  'ar_collections',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    collectionDate: date('collection_date').notNull(),
    /** The GROSS receivable cleared. What reaches the bank is this minus `platformFee`. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /**
     * ⛔ **Booked here and nowhere else.** v1 recognised a platform fee TWICE and it cost
     * **₱198,148.29** across two stores, with 37 duplicate expense documents voided. A module
     * that posts this collection *and* lets someone expense the same fee separately has
     * reintroduced that defect. `POSTING-PATTERNS.md` `ar_collection`, 176 verified legs.
     */
    platformFee: numeric('platform_fee', { precision: 14, scale: 2 }).notNull().default('0'),
    moneyAccountId: uuid('money_account_id').notNull().references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    referenceNo: text('reference_no'),
    notes: text('notes'),
    /** v1's real rule, ported: required for an ONLINE collection, never for cash. */
    receiptFileId: uuid('receipt_file_id').references(() => storedFiles.id, { onDelete: 'restrict' }),
    status: text('status', { enum: AR_DOC_STATUSES }).notNull().default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('ar_collections_org_customer_idx').on(t.orgId, t.customerId),
    check('ar_collections_amount_positive_check', sql`${t.amount} > 0`),
    check('ar_collections_fee_not_negative_check', sql`${t.platformFee} >= 0`),
    check('ar_collections_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    check('ar_collections_platform_fee_finite_check', sql`${t.platformFee} > '-Infinity'::numeric and ${t.platformFee} < 'Infinity'::numeric`),
    // T-357 / DEF-490, migration 0171 — the single-column FK above accepts a cross-org account
    // (RLS checks only this row's own org_id; the FK check runs as the table owner). References
    // `money_accounts_org_id_id_unique` (`schema/money-accounts.ts` — hand-added in migration
    // 0171).
    foreignKey({
      columns: [t.orgId, t.moneyAccountId],
      foreignColumns: [moneyAccounts.orgId, moneyAccounts.id],
      name: 'ar_collections_money_account_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'ar_collections_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'ar_collections_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'ar_collections_voided_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `customer_id` FK (RLS checks only this row's org_id); references `customers_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'ar_collections_customer_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'ar_collections_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `receipt_file_id` FK (RLS checks only this row's org_id); references `stored_files_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.receiptFileId],
      foreignColumns: [storedFiles.orgId, storedFiles.id],
      name: 'ar_collections_receipt_file_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const arCollectionAllocations = pgTable(
  'ar_collection_allocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    arCollectionId: uuid('ar_collection_id')
      .notNull()
      .references(() => arCollections.id, { onDelete: 'cascade' }),
    arChargeId: uuid('ar_charge_id').notNull().references(() => arCharges.id, { onDelete: 'restrict' }),
    amountApplied: numeric('amount_applied', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('ar_collection_allocations_collection_charge_key').on(t.arCollectionId, t.arChargeId),
    index('ar_collection_allocations_charge_idx').on(t.arChargeId),
    check('ar_collection_allocations_amount_applied_finite_check', sql`${t.amountApplied} > '-Infinity'::numeric and ${t.amountApplied} < 'Infinity'::numeric`),
  ],
);

/**
 * ⛔ **Admin only, and never the charge's own author.** v1 has no identity check anywhere in AR;
 * this is the second-party control T-130 added to invoice verification, applied to the one AR
 * action that makes a debt disappear. Writing off your own receivable is how a shortfall is buried.
 */
export const arWriteOffs = pgTable(
  'ar_write_offs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    arChargeId: uuid('ar_charge_id').notNull().references(() => arCharges.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    writtenOffBy: uuid('written_off_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    writtenOffAt: timestamp('written_off_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ar_write_offs_charge_idx').on(t.arChargeId),
    check('ar_write_offs_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    // T-367 S1 / DEF-201 (R2): one write-off decision makes exactly one row — the DB backstop
    // beside `writeOffCharge`'s own idempotency-key retry (bible §15.11). Migration 0173.
    uniqueIndex('ar_write_offs_journal_entry_unique').on(t.journalEntryId),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.writtenOffBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'ar_write_offs_written_off_by_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `ar_charge_id` FK (RLS checks only this row's org_id); references `ar_charges_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.arChargeId],
      foreignColumns: [arCharges.orgId, arCharges.id],
      name: 'ar_write_offs_ar_charge_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `journal_entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'ar_write_offs_journal_entry_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
