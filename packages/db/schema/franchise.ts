/**
 * T-398 S6 (migration 0220) - the franchisor's view of a franchisee's sales and stock, the access log every look leaves, and break-glass logging.
 * docs/tasks/398-padre-garcia-franchise-org.md section 0b, docs/tasks/398-s6/S6-REFRESH.md section 3.
 *
 * `franchise_agreements`: one row per franchisee (org_id = the franchisee, franchisor_org_id = the franchisor). The app role has SELECT only; the owner path writes it.
 * `franchise_access_log`: append-only for EVERY role. Written only by the SECURITY DEFINER readers (franchise_sales_daily, franchise_stock_levels),
 * log_break_glass_approval and the sessions trigger sessions_break_glass_log_trg. RLS scope 'dual_org_counterparty' (rls/registry.ts): SELECT admits the
 * franchisee (org_id) and its franchisor (franchisor_org_id); nobody else; no write policy.
 *
 * Everything the model cannot express is hand-added in migration 0220 (see the NOTE comments): the UNIQUE keys, the per-kind shape CHECKs, the policies, the grants,
 * the append-only triggers (ENABLE ALWAYS), the agreements guard, the sessions trigger and the SECURITY DEFINER functions.
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const FRANCHISE_LOG_KINDS = ['sales_daily', 'stock_levels', 'break_glass_sign_in', 'break_glass_approval'] as const;
export type FranchiseLogKind = (typeof FRANCHISE_LOG_KINDS)[number];

export const franchiseAgreements = pgTable(
  'franchise_agreements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** The FRANCHISEE (e.g. Padre Garcia). UNIQUE: one franchisor per franchisee. */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The FRANCHISOR (Ian's company). CHECK franchisor_org_id <> org_id. */
    franchisorOrgId: uuid('franchisor_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The franchisor's own person INSIDE the franchisee's organisation (break-glass). UNIQUE; composite (org_id, franchisor_person_id) -> persons (org_id, id). */
    franchisorPersonId: uuid('franchisor_person_id').notNull(),
    /** The first date the franchisor may see (inclusive). */
    salesVisibleFrom: date('sales_visible_from').notNull(),
    /** The agreement ends on this date (Manila): from then on the readers refuse 42501. NULL = running. Written by the owner path only. */
    endedOn: date('ended_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('franchise_agreements_franchisor_differs_check', sql`${t.franchisorOrgId} <> ${t.orgId}`),
    // NOTE: UNIQUE (org_id), UNIQUE (org_id, id), UNIQUE (org_id, franchisor_org_id, id), UNIQUE (franchisor_person_id) - hand-added in migration 0220 (T-398 S6), no Drizzle mirror here.
    // NOTE: RLS (ENABLE + FORCE; one SELECT policy: org_id OR franchisor_org_id), SELECT-only grant, trigger franchise_agreements_app_guard_trg and the TRUNCATE guard - hand-added in migration 0220.
    foreignKey({
      columns: [t.orgId, t.franchisorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'franchise_agreements_franchisor_person_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const franchiseAccessLog = pgTable(
  'franchise_access_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** The FRANCHISEE whose data was looked at (or whose person signed in). The log is theirs to read. */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    franchisorOrgId: uuid('franchisor_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Composite (org_id, franchisor_org_id, agreement_id) -> franchise_agreements: the pair on the row is the pair on the agreement. */
    agreementId: uuid('agreement_id').notNull(),
    what: text('what', { enum: FRANCHISE_LOG_KINDS }).notNull(),
    /** The FRANCHISOR's person who looked (sales_daily / stock_levels). Composite (franchisor_org_id, reader_person_id) -> persons (org_id, id). */
    readerPersonId: uuid('reader_person_id'),
    /** The franchisee-side person who signed in / approved (break-glass). Composite (org_id, franchisee_person_id) -> persons (org_id, id). */
    franchiseePersonId: uuid('franchisee_person_id'),
    /** The person's display name AT THE TIME (a snapshot: a later rename must not rewrite who looked). */
    personName: text('person_name').notNull(),
    rangeFrom: date('range_from'),
    rangeTo: date('range_to'),
    /** stock_levels: the store asked for (NULL = every store); sign-in / approval: the terminal or record store. */
    storeId: uuid('store_id'),
    /** break_glass_sign_in only. NO foreign key (K12): sessions is purged at cutover; declared a snapshot in NO_FK_REFERENCES. */
    sessionId: uuid('session_id'),
    credentialKind: text('credential_kind'),
    /** break_glass_approval only. */
    capability: text('capability'),
    /** Reads only. */
    rowsReturned: integer('rows_returned'),
    /** Reads only; optional text typed on the screen (at most 500 characters). */
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('franchise_access_log_org_occurred_idx').on(t.orgId, t.occurredAt.desc()),
    uniqueIndex('franchise_access_log_session_id_key').on(t.sessionId).where(sql`${t.sessionId} is not null`),
    check('franchise_access_log_what_check', sql`${t.what} in ('sales_daily', 'stock_levels', 'break_glass_sign_in', 'break_glass_approval')`),
    // NOTE: the per-kind shape CHECKs (one per `what`, stating exactly which columns are set), the person_name / rows_returned / reason / credential_kind / capability CHECKs - hand-added in migration 0220.
    // NOTE: RLS (ENABLE + FORCE; one SELECT policy), SELECT-only grant, the append-only triggers (BEFORE UPDATE OR DELETE, BEFORE TRUNCATE; both ENABLE ALWAYS), the SECURITY DEFINER functions
    //       franchise_reader_check / franchise_sales_daily / franchise_stock_levels / franchise_franchisees / log_break_glass_approval and sessions_break_glass_log (trigger sessions_break_glass_log_trg on sessions) - hand-added in migration 0220.
    foreignKey({
      columns: [t.orgId, t.franchisorOrgId, t.agreementId],
      foreignColumns: [franchiseAgreements.orgId, franchiseAgreements.franchisorOrgId, franchiseAgreements.id],
      name: 'franchise_access_log_agreement_id_same_pair_fk',
    }).onDelete('restrict'),
    // The declared cross-organisation shape (K6): the reader is checked against the FRANCHISOR organisation.
    foreignKey({
      columns: [t.franchisorOrgId, t.readerPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'franchise_access_log_reader_person_id_franchisor_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.franchiseePersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'franchise_access_log_franchisee_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'franchise_access_log_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
