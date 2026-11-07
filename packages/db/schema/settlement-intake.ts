/**
 * T-511 S2a (migration 0228) - the staging tables of the Grab / Foodpanda settlement upload.
 * docs/designs/channel-settlement-upload.md, docs/tasks/511-settlement-upload-s2-spec.md.
 *
 * ## What these tables are
 *
 * A person uploads a platform statement. The reader (a later slice) turns it into rows HERE and nothing else: no journal entry,
 * no receivable moved. A person then reviews each day and approves or rejects it (a later slice). So these four tables hold
 * "what the file said" and "what the person decided"; the books are untouched until a decision posts through the existing
 * channel-settlement path.
 *
 * ## Append-style on purpose
 *
 * Staged rows are SUPERSEDED, never deleted and never edited: a re-upload inserts a new version and retires the old one. The
 * app role therefore has SELECT and INSERT, and UPDATE only on the handful of columns that carry state (grants below), never
 * on a money column. No DELETE, no TRUNCATE.
 *
 * NOTE: hand-added in migration 0228 for ALL FOUR tables - ENABLE + FORCE RLS and the policy `<table>_org_isolation`
 * (app_current_org()), the grants (SELECT, INSERT, and COLUMN-LEVEL UPDATE: settlement_uploads (superseded_by);
 * settlement_day_lines (review_state, decision_reason, decided_by, decided_at, settlement_id, is_current, changed_since_booked,
 * recorded_figure, difference); settlement_loan_lines (is_active); settlement_other_lines (is_current)), the finite checks on
 * every money column, the unique `(org_id, id)` constraints on the two parents and the column comments on `order_value`,
 * `gross_info` and `vendor_discount`. Foreign keys are composite-only `(org_id, col)` twins (t398 C1); the channel reference on uploads and day lines is the
 * 3-column `(org_id, channel_id, store_id)` -> `sales_channels (org_id, id, store_id)`, so their store_id always equals the channel's store. Also hand-added:
 * `sales_channels_org_id_id_store_id_unique` (that FK's target; see schema/sales-days.ts). The partial unique `settlement_day_lines_settlement_id_key` is mirrored below.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { channelSettlements } from './channel-settlements';
import { journalEntries } from './journal';
import { loans } from './loans';
import { organizations } from './organizations';
import { persons } from './persons';
import { salesChannels, salesDays } from './sales-days';
import { storedFiles } from './stored-files';
import { stores } from './stores';

export const SETTLEMENT_PLATFORMS = ['grab', 'foodpanda'] as const;
export type SettlementPlatform = (typeof SETTLEMENT_PLATFORMS)[number];

export const SETTLEMENT_FILE_KINDS = ['grab_transactions', 'grab_transfers', 'foodpanda_invoice'] as const;
export type SettlementFileKind = (typeof SETTLEMENT_FILE_KINDS)[number];

export const SETTLEMENT_REVIEW_STATES = ['pending', 'booked', 'rejected'] as const;
export type SettlementReviewState = (typeof SETTLEMENT_REVIEW_STATES)[number];

export const SETTLEMENT_PAID_STATES = ['paid', 'not_paid'] as const;
export type SettlementPaidState = (typeof SETTLEMENT_PAID_STATES)[number];

export const SETTLEMENT_LOAN_LINE_KINDS = ['deduction', 'disbursal'] as const;
export type SettlementLoanLineKind = (typeof SETTLEMENT_LOAN_LINE_KINDS)[number];

export const SETTLEMENT_ALLOCATION_SOURCES = ['auto', 'admin'] as const;
export type SettlementAllocationSource = (typeof SETTLEMENT_ALLOCATION_SOURCES)[number];

export const SETTLEMENT_OTHER_LINE_KINDS = [
  'adjustment',
  'compensation',
  'chargeback',
  'withholding_tax',
  'advertisement',
  'cancelled_order',
  'period_charge',
  'platform_fee_weekly',
  'pandago',
] as const;
export type SettlementOtherLineKind = (typeof SETTLEMENT_OTHER_LINE_KINDS)[number];

export const SETTLEMENT_OTHER_BOOKED_AS = ['platformFee', 'marketing', 'none'] as const;
export type SettlementOtherBookedAs = (typeof SETTLEMENT_OTHER_BOOKED_AS)[number];

const finite = (col: AnyPgColumn) => sql`${col} > '-Infinity'::numeric and ${col} < 'Infinity'::numeric`;

// -------------------------------------------------------------------------------------
// settlement_uploads - one row per uploaded file.
// -------------------------------------------------------------------------------------

export const settlementUploads = pgTable(
  'settlement_uploads',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    storeId: uuid('store_id').notNull(),
    platform: text('platform', { enum: SETTLEMENT_PLATFORMS }).notNull(),
    fileKind: text('file_kind', { enum: SETTLEMENT_FILE_KINDS }).notNull(),
    /** The CSV or the zip, as stored (purpose `channel_settlement_file`). */
    fileId: uuid('file_id').notNull(),
    /** The Foodpanda PDF, stored for the record and never parsed. */
    pdfFileId: uuid('pdf_file_id'),
    /** sha256 hex of the uploaded bytes. Unique per org: the same file twice is refused. Deliberately not named `*_id`. */
    fingerprint: text('fingerprint').notNull(),
    readerVersion: text('reader_version').notNull(),
    /** The platform store code the file carried, as matched to the channel. */
    matchedCode: text('matched_code'),
    periodFrom: date('period_from'),
    periodTo: date('period_to'),
    /** Foodpanda only. */
    invoiceNumber: text('invoice_number'),
    ordersRead: integer('orders_read').notNull().default(0),
    loanRowsRead: integer('loan_rows_read').notNull().default(0),
    otherRowsRead: integer('other_rows_read').notNull().default(0),
    /** The upload that replaced this one; NULL = current. */
    supersededBy: uuid('superseded_by'),
    uploadedBy: uuid('uploaded_by').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('settlement_uploads_org_id_id_unique').on(t.orgId, t.id),
    uniqueIndex('settlement_uploads_org_fingerprint_key').on(t.orgId, t.fingerprint),
    index('settlement_uploads_org_channel_idx').on(t.orgId, t.channelId),
    check('settlement_uploads_platform_check', sql`${t.platform} in ('grab', 'foodpanda')`),
    check('settlement_uploads_file_kind_check', sql`${t.fileKind} in ('grab_transactions', 'grab_transfers', 'foodpanda_invoice')`),
    check('settlement_uploads_counts_check', sql`${t.ordersRead} >= 0 and ${t.loanRowsRead} >= 0 and ${t.otherRowsRead} >= 0`),
    // 3 columns (delta, BOSS 3 Nov): pins the org AND the store, so an upload's store_id is always its channel's store. Replaces the (org_id, channel_id) twin.
    // Targets the hand-added `sales_channels_org_id_id_store_id_unique` (migration 0228; see schema/sales-days.ts).
    foreignKey({ columns: [t.orgId, t.channelId, t.storeId], foreignColumns: [salesChannels.orgId, salesChannels.id, salesChannels.storeId], name: 'settlement_uploads_channel_store_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'settlement_uploads_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.fileId], foreignColumns: [storedFiles.orgId, storedFiles.id], name: 'settlement_uploads_file_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.pdfFileId], foreignColumns: [storedFiles.orgId, storedFiles.id], name: 'settlement_uploads_pdf_file_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.uploadedBy], foreignColumns: [persons.orgId, persons.id], name: 'settlement_uploads_uploaded_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.supersededBy], foreignColumns: [t.orgId, t.id], name: 'settlement_uploads_superseded_by_same_org_fk' }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------
// settlement_day_lines - one row per channel, sales date and version.
// -------------------------------------------------------------------------------------

export const settlementDayLines = pgTable(
  'settlement_day_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    storeId: uuid('store_id').notNull(),
    platform: text('platform', { enum: SETTLEMENT_PLATFORMS }).notNull(),
    salesDate: date('sales_date').notNull(),
    version: integer('version').notNull().default(1),
    isCurrent: boolean('is_current').notNull().default(true),
    sourceUploadId: uuid('source_upload_id').notNull(),
    /** Grab only: the Transfers file that carried the payout. */
    payoutUploadId: uuid('payout_upload_id'),

    /** ⭐ NET: what staff record (Grab "Net Sales", Foodpanda column R), i.e. AFTER the platform discount. Not the gross. */
    orderValue: numeric('order_value', { precision: 14, scale: 2 }).notNull(),
    /** Information only (Grab "Amount", Foodpanda column K): the gross before the discount. Never booked. */
    grossInfo: numeric('gross_info', { precision: 14, scale: 2 }).notNull(),
    /** Stored positive. */
    commission: numeric('commission', { precision: 14, scale: 2 }).notNull(),
    marketing: numeric('marketing', { precision: 14, scale: 2 }).notNull(),
    /** Signed. */
    platformFee: numeric('platform_fee', { precision: 14, scale: 2 }).notNull(),
    /** Information only, signed (Grab merchant-funded discount; Foodpanda O+P+Q). Never booked: staff record the sale net of it. */
    vendorDiscount: numeric('vendor_discount', { precision: 14, scale: 2 }).notNull(),
    loanDeduction: numeric('loan_deduction', { precision: 14, scale: 2 }).notNull(),
    loanDisbursal: numeric('loan_disbursal', { precision: 14, scale: 2 }).notNull(),
    netPayout: numeric('net_payout', { precision: 14, scale: 2 }).notNull(),
    unexplained: numeric('unexplained', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Snapshots for display; both are re-read at approval. */
    recordedFigure: numeric('recorded_figure', { precision: 14, scale: 2 }),
    difference: numeric('difference', { precision: 14, scale: 2 }),

    /** Grab Settlement ID, or the Foodpanda invoice number. */
    payoutReference: text('payout_reference'),
    payoutDate: date('payout_date'),
    paymentArrivalDate: date('payment_arrival_date'),
    paidState: text('paid_state', { enum: SETTLEMENT_PAID_STATES }).notNull(),
    /** Foodpanda: the month text the Platform Fee row carried. */
    feeMonthNote: text('fee_month_note'),
    changedSinceBooked: boolean('changed_since_booked').notNull().default(false),

    reviewState: text('review_state', { enum: SETTLEMENT_REVIEW_STATES }).notNull().default('pending'),
    decisionReason: text('decision_reason'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    settlementId: uuid('settlement_id'),
  },
  (t) => [
    unique('settlement_day_lines_org_id_id_unique').on(t.orgId, t.id),
    uniqueIndex('settlement_day_lines_current_key').on(t.orgId, t.channelId, t.salesDate).where(sql`${t.isCurrent}`),
    uniqueIndex('settlement_day_lines_version_key').on(t.orgId, t.channelId, t.salesDate, t.version),
    // delta, BOSS 3 Nov: one day line per channel_settlements row. Partial (pending and rejected lines have no settlement).
    uniqueIndex('settlement_day_lines_settlement_id_key').on(t.orgId, t.settlementId).where(sql`${t.settlementId} is not null`),
    index('settlement_day_lines_org_store_date_idx').on(t.orgId, t.storeId, t.salesDate),
    check('settlement_day_lines_platform_check', sql`${t.platform} in ('grab', 'foodpanda')`),
    check('settlement_day_lines_version_check', sql`${t.version} >= 1`),
    check('settlement_day_lines_paid_state_check', sql`${t.paidState} in ('paid', 'not_paid')`),
    check('settlement_day_lines_review_state_check', sql`${t.reviewState} in ('pending', 'booked', 'rejected')`),
    check(
      'settlement_day_lines_review_shape_check',
      sql`(${t.reviewState} = 'pending' and ${t.decisionReason} is null and ${t.decidedBy} is null and ${t.decidedAt} is null and ${t.settlementId} is null)
          or (${t.reviewState} = 'rejected' and ${t.decisionReason} is not null and length(trim(${t.decisionReason})) > 0 and ${t.decidedBy} is not null and ${t.decidedAt} is not null and ${t.settlementId} is null)
          or (${t.reviewState} = 'booked' and ${t.decidedBy} is not null and ${t.decidedAt} is not null and ${t.settlementId} is not null)`,
    ),
    check('settlement_day_lines_order_value_finite_check', finite(t.orderValue)),
    check('settlement_day_lines_gross_info_finite_check', finite(t.grossInfo)),
    check('settlement_day_lines_commission_finite_check', finite(t.commission)),
    check('settlement_day_lines_marketing_finite_check', finite(t.marketing)),
    check('settlement_day_lines_platform_fee_finite_check', finite(t.platformFee)),
    check('settlement_day_lines_vendor_discount_finite_check', finite(t.vendorDiscount)),
    check('settlement_day_lines_loan_deduction_finite_check', finite(t.loanDeduction)),
    check('settlement_day_lines_loan_disbursal_finite_check', finite(t.loanDisbursal)),
    check('settlement_day_lines_net_payout_finite_check', finite(t.netPayout)),
    check('settlement_day_lines_unexplained_finite_check', finite(t.unexplained)),
    check('settlement_day_lines_recorded_figure_finite_check', finite(t.recordedFigure)),
    check('settlement_day_lines_difference_finite_check', finite(t.difference)),
    // 3 columns (delta, BOSS 3 Nov): pins the org AND the store, so a day line's store_id is always its channel's store (managers are scoped by it). Replaces the (org_id, channel_id) twin.
    foreignKey({ columns: [t.orgId, t.channelId, t.storeId], foreignColumns: [salesChannels.orgId, salesChannels.id, salesChannels.storeId], name: 'settlement_day_lines_channel_store_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'settlement_day_lines_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.sourceUploadId], foreignColumns: [settlementUploads.orgId, settlementUploads.id], name: 'settlement_day_lines_source_upload_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.payoutUploadId], foreignColumns: [settlementUploads.orgId, settlementUploads.id], name: 'settlement_day_lines_payout_upload_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.decidedBy], foreignColumns: [persons.orgId, persons.id], name: 'settlement_day_lines_decided_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.settlementId], foreignColumns: [channelSettlements.orgId, channelSettlements.id], name: 'settlement_day_lines_settlement_id_same_org_fk' }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------
// settlement_loan_lines - allocation units for a day's loan rows.
// -------------------------------------------------------------------------------------

export const settlementLoanLines = pgTable(
  'settlement_loan_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    dayLineId: uuid('day_line_id').notNull(),
    kind: text('kind', { enum: SETTLEMENT_LOAN_LINE_KINDS }).notNull(),
    /** A magnitude; the sign comes from `kind`. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    rowOrdinal: integer('row_ordinal').notNull(),
    /** NULL = not yet allocated to a loan. */
    loanId: uuid('loan_id'),
    allocationSource: text('allocation_source', { enum: SETTLEMENT_ALLOCATION_SOURCES }).notNull().default('auto'),
    /** An admin override inserts new active lines and flips the old ones inactive. */
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    index('settlement_loan_lines_org_day_line_idx').on(t.orgId, t.dayLineId),
    check('settlement_loan_lines_kind_check', sql`${t.kind} in ('deduction', 'disbursal')`),
    check('settlement_loan_lines_amount_positive_check', sql`${t.amount} > 0`),
    check('settlement_loan_lines_amount_finite_check', finite(t.amount)),
    check('settlement_loan_lines_allocation_source_check', sql`${t.allocationSource} in ('auto', 'admin')`),
    foreignKey({ columns: [t.orgId, t.dayLineId], foreignColumns: [settlementDayLines.orgId, settlementDayLines.id], name: 'settlement_loan_lines_day_line_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.loanId], foreignColumns: [loans.orgId, loans.id], name: 'settlement_loan_lines_loan_id_same_org_fk' }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------
// settlement_other_lines - adjustments, charges and the like.
// -------------------------------------------------------------------------------------

export const settlementOtherLines = pgTable(
  'settlement_other_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    uploadId: uuid('upload_id').notNull(),
    /** NULL for a period-level line. */
    dayLineId: uuid('day_line_id'),
    kind: text('kind', { enum: SETTLEMENT_OTHER_LINE_KINDS }).notNull(),
    bookedAs: text('booked_as', { enum: SETTLEMENT_OTHER_BOOKED_AS }).notNull(),
    /** Signed. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    lineDate: date('line_date'),
    /** Generic text only: no names, no personal data. */
    description: text('description'),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (t) => [
    index('settlement_other_lines_org_upload_idx').on(t.orgId, t.uploadId),
    check('settlement_other_lines_kind_check', sql`${t.kind} in ('adjustment', 'compensation', 'chargeback', 'withholding_tax', 'advertisement', 'cancelled_order', 'period_charge', 'platform_fee_weekly', 'pandago')`),
    check('settlement_other_lines_booked_as_check', sql`${t.bookedAs} in ('platformFee', 'marketing', 'none')`),
    /** PandaGO is never booked from a settlement statement. */
    check('settlement_other_lines_pandago_check', sql`${t.kind} <> 'pandago' or ${t.bookedAs} = 'none'`),
    check('settlement_other_lines_description_length_check', sql`${t.description} is null or char_length(${t.description}) <= 200`),
    check('settlement_other_lines_amount_finite_check', finite(t.amount)),
    foreignKey({ columns: [t.orgId, t.uploadId], foreignColumns: [settlementUploads.orgId, settlementUploads.id], name: 'settlement_other_lines_upload_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.dayLineId], foreignColumns: [settlementDayLines.orgId, settlementDayLines.id], name: 'settlement_other_lines_day_line_id_same_org_fk' }).onDelete('restrict'),
  ],
);

/**
 * T-511 S6b (the platform-corrections migration) - the append-only record of a platform sales correction (`correctPlatformSales`): the platform's file figure replaced the staff
 * figure for one channel and day through a correcting journal entry. One row per staged day line per sales day. `fromAmount` is what the ledger held for that channel and day
 * (the staff entry plus earlier corrections, never `sales_day_channels.amount`, which is not overwritten); `toAmount` is the file figure; `entryDate` is where the
 * entry was posted (the sales day if its month was open, else the first open date after it).
 *
 * NOTE: hand-added in the platform-corrections migration, no Drizzle mirror here: ENABLE and FORCE ROW LEVEL SECURITY, the policy sales_day_platform_corrections_org_isolation
 * (app_current_org()), the grants (SELECT and INSERT only: corrections are history), the append-only refuse trigger sales_day_platform_corrections_append_only
 * (ENABLE ALWAYS) and the finite checks on both amounts.
 */
export const salesDayPlatformCorrections = pgTable(
  'sales_day_platform_corrections',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull(),
    salesDayId: uuid('sales_day_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    dayLineId: uuid('day_line_id').notNull(),
    fromAmount: numeric('from_amount', { precision: 14, scale: 2 }).notNull(),
    toAmount: numeric('to_amount', { precision: 14, scale: 2 }).notNull(),
    entryDate: date('entry_date').notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    reason: text('reason').notNull(),
    postedBy: uuid('posted_by').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sales_day_platform_corrections_day_and_line_unique').on(t.orgId, t.salesDayId, t.dayLineId),
    unique('sales_day_platform_corrections_journal_entry_unique').on(t.orgId, t.journalEntryId),
    check('sales_day_platform_corrections_amounts_differ_check', sql`${t.fromAmount} <> ${t.toAmount}`),
    check('sales_day_platform_corrections_reason_not_blank_check', sql`btrim(${t.reason}) <> ''`),
    check('sales_day_platform_corrections_from_amount_finite_check', finite(t.fromAmount)),
    check('sales_day_platform_corrections_to_amount_finite_check', finite(t.toAmount)),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'sales_day_platform_corrections_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.salesDayId], foreignColumns: [salesDays.orgId, salesDays.id], name: 'sales_day_platform_corrections_sales_day_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [salesChannels.orgId, salesChannels.id], name: 'sales_day_platform_corrections_channel_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.dayLineId], foreignColumns: [settlementDayLines.orgId, settlementDayLines.id], name: 'sales_day_platform_corrections_day_line_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: 'sales_day_platform_corrections_journal_entry_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.postedBy], foreignColumns: [persons.orgId, persons.id], name: 'sales_day_platform_corrections_posted_by_same_org_fk' }).onDelete('restrict'),
  ],
);
