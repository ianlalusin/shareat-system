/**
 * T-472 S1, migration 0216 - the nightly per-receipt bridge: a faithful, READ-ONLY copy of every POS receipt
 * (`docs/tasks/472-pos-nightly-receipt-bridge.md`, Rulings 3-7). Nothing here posts to the books; `sales_days` is untouched.
 *
 *  - `pos_bridge_receipts`         one row per receipt VERSION. A new version only when the document's hash changes.
 *  - `pos_bridge_receipt_lines`    the lines of one version.
 *  - `pos_bridge_receipt_tenders`  the payments of one version.
 *  - `pos_bridge_day_checks`       per store-day: our receipts against the POS day feed. A check, not truth (Ruling 6).
 *  - `pos_bridge_receipts_current` (view, hand-added in 0216) the latest version of each document.
 *
 * Money is whole centavos in `bigint`, never float (RULES #6). `money_flag` is set when POS's value was not a whole
 * centavo (the receipt is still copied, Ruling 5).
 *
 * NO PERSONAL DATA (Ruling 7, Ian 24 Oct): no customer name/TIN/address and no senior/PWD name or ID number in any column
 * or in `raw`. `tests/integration/t472-s1-bridge-schema.test.ts` fails on a personal-data column name.
 *
 * Every child has its OWN `org_id` and a composite FK `(org_id, receipt_id)` -> `pos_bridge_receipts(org_id, id)`: no
 * single-column org->org FK (DEF-491), no via-header policy, no trigger. Children also carry `pos_calendar_date` so the
 * 2027-01-01 cutover (date_scoped, Ruling 4) can purge each table by its own column; the database does not check that
 * a child's date equals its header's, the writer (S2) sets it from the header.
 *
 * NOTE (hand-added in migration 0216, Drizzle cannot say these): ENABLE + FORCE ROW LEVEL SECURITY and the org-isolation
 * policies, the grants (receipts/lines/tenders SELECT+INSERT only; day_checks SELECT+INSERT+UPDATE), the view.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';
import { posV1DayFeeds, tenders } from './pos-v1';

export const POS_BRIDGE_RECEIPT_KINDS = ['sale', 'refund'] as const;
export type PosBridgeReceiptKind = (typeof POS_BRIDGE_RECEIPT_KINDS)[number];

export const POS_BRIDGE_RECEIPT_STATUSES = ['final', 'voided', 'gone'] as const;
export type PosBridgeReceiptStatus = (typeof POS_BRIDGE_RECEIPT_STATUSES)[number];

export const POS_BRIDGE_CHECK_RESULTS = ['match', 'mismatch', 'pending'] as const;
export type PosBridgeCheckResult = (typeof POS_BRIDGE_CHECK_RESULTS)[number];

const centavos = (name: string) => bigint(name, { mode: 'number' });

export const posBridgeReceipts = pgTable(
  'pos_bridge_receipts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull(),
    /** POS's own (Firestore) store id the document was read from. */
    posStoreId: text('pos_store_id').notNull(),
    /** The Firestore document id. Never the receipt number or terminal seq (GLOSSARY: the terminal sequence is not a monotonic key). */
    firestoreDocId: text('firestore_doc_id').notNull(),
    version: integer('version').notNull(),
    kind: text('kind', { enum: POS_BRIDGE_RECEIPT_KINDS }).notNull(),
    status: text('status', { enum: POS_BRIDGE_RECEIPT_STATUSES }).notNull(),
    receiptNumber: text('receipt_number'),
    terminalNo: text('terminal_no'),
    /** For a refund: the Firestore id of the receipt it refunds. */
    parentDocId: text('parent_doc_id'),
    /** The terminal's own clock (`createdAtClientMs`); null when POS did not stamp it. */
    clientAt: timestamp('client_at', { withTimezone: true }),
    /** The Manila calendar day the receipt belongs to. The key for day checks and the cutover floor. */
    posCalendarDate: date('pos_calendar_date').notNull(),
    subtotalCentavos: centavos('subtotal_centavos').notNull(),
    discountCentavos: centavos('discount_centavos').notNull(),
    totalCentavos: centavos('total_centavos').notNull(),
    /** True when any money figure of this receipt (or its lines/tenders) was not a whole centavo in POS. */
    moneyFlag: boolean('money_flag').notNull().default(false),
    /** The copied fields, minus every personal field (Ruling 7) and housekeeping stamps (Ruling 3). */
    raw: jsonb('raw').notNull(),
    /** sha256 hex of the stable JSON of the copied fields. */
    docHash: text('doc_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pos_bridge_receipts_version_unique').on(t.orgId, t.posStoreId, t.firestoreDocId, t.version),
    unique('pos_bridge_receipts_org_id_id_unique').on(t.orgId, t.id),
    index('pos_bridge_receipts_store_day_idx').on(t.orgId, t.storeId, t.posCalendarDate),
    check('pos_bridge_receipts_version_check', sql`${t.version} >= 1`),
    check('pos_bridge_receipts_kind_check', sql`${t.kind} in ('sale', 'refund')`),
    check('pos_bridge_receipts_status_check', sql`${t.status} in ('final', 'voided', 'gone')`),
    check('pos_bridge_receipts_doc_hash_check', sql`${t.docHash} ~ '^[0-9a-f]{64}$'`),
    check('pos_bridge_receipts_pos_store_id_not_blank_check', sql`btrim(${t.posStoreId}) <> ''`),
    check('pos_bridge_receipts_firestore_doc_id_not_blank_check', sql`btrim(${t.firestoreDocId}) <> ''`),
    check('pos_bridge_receipts_raw_object_check', sql`jsonb_typeof(${t.raw}) = 'object'`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'pos_bridge_receipts_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const posBridgeReceiptLines = pgTable(
  'pos_bridge_receipt_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    receiptId: uuid('receipt_id').notNull(),
    lineNo: integer('line_no').notNull(),
    posCalendarDate: date('pos_calendar_date').notNull(),
    /** POS's own item id; text because POS menu ids are not ours. */
    posItemId: text('pos_item_id'),
    itemName: text('item_name').notNull(),
    /** Not money: a count or weight. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPriceCentavos: centavos('unit_price_centavos').notNull(),
    discountCentavos: centavos('discount_centavos').notNull().default(0),
    lineTotalCentavos: centavos('line_total_centavos').notNull(),
    moneyFlag: boolean('money_flag').notNull().default(false),
  },
  (t) => [
    unique('pos_bridge_receipt_lines_receipt_line_unique').on(t.orgId, t.receiptId, t.lineNo),
    index('pos_bridge_receipt_lines_date_idx').on(t.orgId, t.posCalendarDate),
    check('pos_bridge_receipt_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('pos_bridge_receipt_lines_quantity_finite_check', sql`${t.quantity} > '-Infinity'::numeric and ${t.quantity} < 'Infinity'::numeric`),
    foreignKey({
      columns: [t.orgId, t.receiptId],
      foreignColumns: [posBridgeReceipts.orgId, posBridgeReceipts.id],
      name: 'pos_bridge_receipt_lines_receipt_id_same_org_fk',
    }).onDelete('cascade'),
  ],
);

export const posBridgeReceiptTenders = pgTable(
  'pos_bridge_receipt_tenders',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    receiptId: uuid('receipt_id').notNull(),
    seq: integer('seq').notNull(),
    posCalendarDate: date('pos_calendar_date').notNull(),
    /** How POS spells the method on this receipt (as `analytics.mop` names it). */
    methodAlias: text('method_alias').notNull(),
    /** Our tender master row when the alias matched (`normalizePosV1Alias`); null when it did not. */
    tenderId: uuid('tender_id'),
    amountCentavos: centavos('amount_centavos').notNull(),
    moneyFlag: boolean('money_flag').notNull().default(false),
  },
  (t) => [
    unique('pos_bridge_receipt_tenders_receipt_seq_unique').on(t.orgId, t.receiptId, t.seq),
    index('pos_bridge_receipt_tenders_date_idx').on(t.orgId, t.posCalendarDate),
    check('pos_bridge_receipt_tenders_seq_check', sql`${t.seq} >= 1`),
    foreignKey({
      columns: [t.orgId, t.receiptId],
      foreignColumns: [posBridgeReceipts.orgId, posBridgeReceipts.id],
      name: 'pos_bridge_receipt_tenders_receipt_id_same_org_fk',
    }).onDelete('cascade'),
    // MATCH SIMPLE: a NULL tender_id (alias did not match) skips the check. References `tenders_org_id_id_unique` (0216, pos-v1.ts).
    foreignKey({
      columns: [t.orgId, t.tenderId],
      foreignColumns: [tenders.orgId, tenders.id],
      name: 'pos_bridge_receipt_tenders_tender_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const posBridgeDayChecks = pgTable(
  'pos_bridge_day_checks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull(),
    posStoreId: text('pos_store_id').notNull(),
    posCalendarDate: date('pos_calendar_date').notNull(),
    /** Latest-version receipts of the day that are final (sales and refunds). */
    receiptCount: integer('receipt_count').notNull(),
    /** Sum of final sales minus refunds, from the latest versions. */
    netSalesCentavos: centavos('net_sales_centavos').notNull(),
    /** The day-feed figure it was compared with; null (and result `pending`) when no feed exists yet. */
    feedTotalCentavos: centavos('feed_total_centavos'),
    feedId: uuid('feed_id'),
    /** `net_sales_centavos - feed_total_centavos`; null while pending. */
    differenceCentavos: centavos('difference_centavos'),
    result: text('result', { enum: POS_BRIDGE_CHECK_RESULTS }).notNull(),
    /** Recomputed nightly: the row is UPDATEd in place. */
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pos_bridge_day_checks_store_day_unique').on(t.orgId, t.storeId, t.posCalendarDate),
    index('pos_bridge_day_checks_date_idx').on(t.orgId, t.posCalendarDate),
    check('pos_bridge_day_checks_result_check', sql`${t.result} in ('match', 'mismatch', 'pending')`),
    check('pos_bridge_day_checks_receipt_count_check', sql`${t.receiptCount} >= 0`),
    check(
      'pos_bridge_day_checks_pending_shape_check',
      sql`(${t.result} = 'pending') = (${t.feedTotalCentavos} is null) and (${t.feedTotalCentavos} is null) = (${t.differenceCentavos} is null)`,
    ),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'pos_bridge_day_checks_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.feedId],
      foreignColumns: [posV1DayFeeds.orgId, posV1DayFeeds.id],
      name: 'pos_bridge_day_checks_feed_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
