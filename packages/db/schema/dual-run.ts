/**
 * T-392 S3 (migration 0195) - the dual-run comparator's stored output. docs/tasks/392-dual-run-comparator.md
 * Contract section 3 and "S3 rulings".
 *
 * `dual_run_reports` is one row per store-week VERSION (R8: append, never update; the identity below is unique and a
 * changed fingerprint is a new row). `dual_run_lines` is that report's line table (it carries org_id, copied
 * from its report, and the composite FK holds). `dual_run_dispositions` is what a PERSON asserted about a delta: V1_DEFECT or V2_DEFECT, always with a DEF-nnn
 * ref (R10). All three are append-only for the app role: SELECT and INSERT, no UPDATE, no DELETE.
 */
import { sql } from 'drizzle-orm';
import {
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
import { persons } from './persons';
import { stores } from './stores';

/** The seven line kinds (ruling 6). `inventory_basis` is a line kind of its own. */
export const DUAL_RUN_KINDS = [
  'cash_bank',
  'staff_cash',
  'sales_tender',
  'expense_category',
  'ap_supplier',
  'inventory_basis',
  'unassigned_store',
] as const;
export type DualRunKind = (typeof DUAL_RUN_KINDS)[number];

export const DUAL_RUN_VERDICTS = ['no_data', 'ties', 'explained', 'open'] as const;
export type DualRunVerdict = (typeof DUAL_RUN_VERDICTS)[number];

export const dualRunReports = pgTable(
  'dual_run_reports',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    weekStart: date('week_start').notNull(),
    through: date('through').notNull(),
    v1Fingerprint: text('v1_fingerprint').notNull(),
    v2Fingerprint: text('v2_fingerprint').notNull(),
    keysSha: text('keys_sha').notNull(),
    v1SnapshotSha: text('v1_snapshot_sha').notNull(),
    v1ExtractedAt: timestamp('v1_extracted_at', { withTimezone: true }).notNull(),
    verdict: text('verdict', { enum: DUAL_RUN_VERDICTS }).notNull(),
    comparedDays: integer('compared_days').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('dual_run_reports_org_id_id_unique').on(t.orgId, t.id),
    unique('dual_run_reports_identity_unique').on(t.orgId, t.storeId, t.weekStart, t.through, t.v1Fingerprint, t.keysSha, t.v2Fingerprint),
    index('dual_run_reports_store_week_idx').on(t.orgId, t.storeId, t.weekStart),
    check('dual_run_reports_week_monday_check', sql`extract(isodow from ${t.weekStart}) = 1`),
    check('dual_run_reports_through_in_week_check', sql`${t.through} >= ${t.weekStart} AND ${t.through} <= ${t.weekStart} + 6`),
    check('dual_run_reports_verdict_check', sql`${t.verdict} in ('no_data','ties','explained','open')`),
    check('dual_run_reports_compared_days_check', sql`${t.comparedDays} >= 0 AND ${t.comparedDays} <= 7`),
    // ruling 3: no_data => compared_days = 0 (NOT iff: ties, open or explained with 0 compared days are valid).
    check('dual_run_reports_no_data_days_check', sql`${t.verdict} <> 'no_data' OR ${t.comparedDays} = 0`),
    // T-398 S1 / DEF-491 pattern (migration 0194): same-org twins of the single-column persons/stores FKs above.
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'dual_run_reports_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'dual_run_reports_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
// NOTE: ENABLE + FORCE ROW LEVEL SECURITY, the org-isolation policy and the SELECT, INSERT-only grant are hand-added in
// migration 0195 (for all three tables in this file).

export const dualRunLines = pgTable(
  'dual_run_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // The report's org_id, copied by repo/dual-run.ts insertLines; the composite FK below keeps it equal.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    reportId: uuid('report_id')
      .notNull()
      .references(() => dualRunReports.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: DUAL_RUN_KINDS }).notNull(),
    lineKey: text('line_key').notNull(),
    label: text('label').notNull(),
    v1Amount: numeric('v1_amount', { precision: 14, scale: 2 }).notNull(),
    v2Amount: numeric('v2_amount', { precision: 14, scale: 2 }).notNull(),
    delta: numeric('delta', { precision: 14, scale: 2 }).notNull(),
    class: text('class').notNull(),
    paired: boolean('paired').notNull(),
    autoReason: text('auto_reason'),
    perDay: jsonb('per_day').notNull().default(sql`'[]'::jsonb`),
    v1Counter: numeric('v1_counter', { precision: 14, scale: 2 }),
    openingGap: numeric('opening_gap', { precision: 14, scale: 2 }),
  },
  (t) => [
    unique('dual_run_lines_key_unique').on(t.reportId, t.kind, t.lineKey),
    foreignKey({
      columns: [t.orgId, t.reportId],
      foreignColumns: [dualRunReports.orgId, dualRunReports.id],
      name: 'dual_run_lines_report_same_org_fk',
    }).onDelete('restrict'),
    index('dual_run_lines_report_idx').on(t.reportId),
    check(
      'dual_run_lines_kind_check',
      sql`${t.kind} in ('cash_bank','staff_cash','sales_tender','expense_category','ap_supplier','inventory_basis','unassigned_store')`,
    ),
    check('dual_run_lines_delta_check', sql`${t.delta} = ${t.v2Amount} - ${t.v1Amount}`),
    // NOTE: dual_run_lines_class_check lists the 23 codes of CLASS_CATALOGUE (packages/etl/src/dual-run/classes.ts); it is
    // spelled out in migration 0195 only, so db does not import etl. The S3 test (C5) fails if the two drift.
    check('dual_run_lines_v1_amount_finite_check', sql`${t.v1Amount} > '-Infinity'::numeric and ${t.v1Amount} < 'Infinity'::numeric`),
    check('dual_run_lines_v2_amount_finite_check', sql`${t.v2Amount} > '-Infinity'::numeric and ${t.v2Amount} < 'Infinity'::numeric`),
    check('dual_run_lines_delta_finite_check', sql`${t.delta} > '-Infinity'::numeric and ${t.delta} < 'Infinity'::numeric`),
    check('dual_run_lines_v1_counter_finite_check', sql`${t.v1Counter} > '-Infinity'::numeric and ${t.v1Counter} < 'Infinity'::numeric`),
    check('dual_run_lines_opening_gap_finite_check', sql`${t.openingGap} > '-Infinity'::numeric and ${t.openingGap} < 'Infinity'::numeric`),
  ],
);

export const dualRunDispositions = pgTable(
  'dual_run_dispositions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    weekStart: date('week_start').notNull(),
    kind: text('kind', { enum: DUAL_RUN_KINDS }).notNull(),
    lineKey: text('line_key').notNull(),
    deltaAt: numeric('delta_at', { precision: 14, scale: 2 }).notNull(),
    class: text('class', { enum: ['V1_DEFECT', 'V2_DEFECT'] }).notNull(),
    ref: text('ref').notNull(),
    note: text('note').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('dual_run_dispositions_line_idx').on(t.orgId, t.storeId, t.weekStart, t.kind, t.lineKey),
    check(
      'dual_run_dispositions_kind_check',
      sql`${t.kind} in ('cash_bank','staff_cash','sales_tender','expense_category','ap_supplier','inventory_basis','unassigned_store')`,
    ),
    check('dual_run_dispositions_class_check', sql`${t.class} in ('V1_DEFECT','V2_DEFECT')`),
    check('dual_run_dispositions_ref_check', sql`${t.ref} ~ '^DEF-[0-9]+$'`),
    check('dual_run_dispositions_delta_at_finite_check', sql`${t.deltaAt} > '-Infinity'::numeric and ${t.deltaAt} < 'Infinity'::numeric`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'dual_run_dispositions_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'dual_run_dispositions_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export type DualRunReportRow = typeof dualRunReports.$inferSelect;
export type DualRunLineRow = typeof dualRunLines.$inferSelect;
export type DualRunDispositionRow = typeof dualRunDispositions.$inferSelect;
