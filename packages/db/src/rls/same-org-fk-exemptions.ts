/**
 * T-398 S1 / DEF-491 -- the ONE place a same-org foreign-key gap is allowed to live.
 *
 * Read by packages/db/tests/integration/t398-s1-same-org-fk-census.test.ts, which reads
 * pg_constraint and fails the build on any foreign key that crosses a tenant boundary without a
 * same-org guard and is not listed here. Spec: docs/tasks/398-padre-garcia-franchise-org.md R1, A8.
 *
 * Every list is PINNED BY VALUE in that test: changing this file without changing the test is red.
 *
 * Key shape: <child table>.<child column>-><parent table>.
 * Kinds: 'org->org' (both ends carry org_id: the guard is a composite (org_id, col) twin);
 *   'derived->org' / 'derived->derived' / 'org->derived' (an end has no org_id: the guard is an
 *   assert_same_org_via_parent trigger whose tgargs name the FK).
 */

export type FkKind = 'org->org' | 'derived->org' | 'org->derived' | 'derived->derived';

export interface OpenFkEntry {
  readonly fk: string;
  readonly kind: FkKind;
  /** Set on the entries the S1 builder must DELETE in the same change as the migration. */
  readonly closedBy?: 'T-398 S1';
}

export interface ByDesignEntry {
  readonly fk: string;
  readonly reason: string;
  /** The planner ruling that allows it, e.g. 'T-398 R5' or 'bible row 305'. */
  readonly ruling: string;
}

/** Permanent. Never grows without a planner ruling (spec R1). S5 adds the inter-entity links. */
export const CROSS_ORG_BY_DESIGN: readonly ByDesignEntry[] = [];

/** Tables with no tenancy at all (no org_id here or anywhere up their FK chain): FKs among them are out of scope. */
export const ORG_LESS_TABLES: readonly string[] = [
  'etl_quarantine',
  'etl_reconciliation',
  'etl_runs',
  'etl_source_documents',
];

/** The ratchet. S3 and S4 deleted what they fixed: empty since T-398 S4 (0214). A new gap must be fixed, not listed. */
export const OPEN_DEF_491: readonly OpenFkEntry[] = [];

/**
 * T-398 S4 (D3): the 27 derived-scope FKs that ARE their table's own RLS via header (rls/registry.ts). The
 * policy's WITH CHECK forces each one to a header of the caller's organisation, so they are guarded by construction and carry
 * no trigger. PINNED BY VALUE in t398-s4-derived-same-org.test.ts. Key shape: <child>.<col>-><header table>.
 */
export const VIA_HEADER_GUARDED: readonly string[] = [
  'ap_payment_allocations.ap_payment_id->ap_payments',
  'ar_collection_allocations.ar_collection_id->ar_collections',
  'count_lines.session_id->count_sessions',
  'count_session_locations.session_id->count_sessions',
  'customer_return_lines.return_id->customer_returns',
  'delivery_lines.delivery_id->deliveries',
  'employment_positions.employment_id->employments',
  'expense_payments.expense_id->expenses',
  'journal_lines.entry_id->journal_entries',
  'order_wastage_allocations.wastage_id->order_wastages',
  'person_credentials.person_id->persons',
  'person_grants.person_id->persons',
  'person_identities.person_id->persons',
  'person_store_scope.person_id->persons',
  'pos_usage_pull_lines.pull_id->pos_usage_pulls',
  'production_recipe_lines.recipe_id->production_recipes',
  'production_record_lines.record_id->production_records',
  'remittance_allocations.remittance_id->remittances',
  'remittance_lines.remittance_id->remittances',
  'sales_day_channels.sales_day_id->sales_days',
  'sales_day_tenders.sales_day_id->sales_days',
  'sessions.person_id->persons',
  'stock_transfer_lines.transfer_id->stock_transfers',
  'stock_usage_lines.record_id->stock_usage_records',
  'supplier_invoice_lines.supplier_invoice_id->supplier_invoices',
  'supplier_return_lines.return_id->supplier_returns',
  'till_count_lines.shift_id->till_custody_shifts',
];

export interface NoFkReference {
  readonly column: string;
  readonly kind: 'external-key' | 'idempotency-key' | 'polymorphic' | 'asserted-party' | 'ref-gap' | 'snapshot';
  readonly reason: string;
}

/** Every *_id / *_by column with no foreign key. A new one with no entry here fails the census (leg C6). */
export const NO_FK_REFERENCES: readonly NoFkReference[] = [
  { column: 'attendance_credentials.card_id', kind: 'external-key', reason: 'physical card number printed on a badge; not a row reference' },
  { column: 'attendance_punches.client_punch_id', kind: 'idempotency-key', reason: 'client-generated idempotency key from the offline clock terminal' },
  { column: 'attendance_punches.device_id', kind: 'external-key', reason: 'device identifier string reported by the terminal; not a row reference' },
  { column: 'audit_log.device_id', kind: 'external-key', reason: 'T-402: the device that recorded an offline event (POS v2 tablet); no device table exists until POS v2 P1; validated against the attested terminal at upload, not by FK' },
  { column: 'audit_log.entity_id', kind: 'polymorphic', reason: 'audit rows carry their own org_id; entity_id points at whichever table entity_type names, so no single FK is possible' },
  { column: 'clock_terminals.firebase_uid', kind: 'external-key', reason: 'Firebase Auth uid of the terminal account' },
  { column: 'etl_runs.started_by', kind: 'external-key', reason: 'operator label of an ETL run; the ETL tables have no tenancy' },
  { column: 'etl_source_documents.doc_id', kind: 'external-key', reason: 'Firestore document id of the v1 source row' },
  { column: 'inbox_quarantine.client_punch_id', kind: 'idempotency-key', reason: 'client-generated idempotency key of the quarantined inbox event' },
  { column: 'franchise_access_log.session_id', kind: 'snapshot', reason: 'T-398 S6 (K12): the session a break-glass sign-in created, copied at write time; sessions is purged at cutover and the log is kept, so an FK would block the purge' },
  { column: 'journal_entries.source_id', kind: 'polymorphic', reason: 'text id of the source document named by source_type; written by the posting layer' },
  { column: 'journal_lines.channel_id', kind: 'external-key', reason: 'free-text second reporting dimension, no channels table (journal_lines schema comment)' },
  { column: 'journal_lines.party_id', kind: 'asserted-party', reason: 'text counterparty id with party_type; ASSERTED by census leg C5 against the party table of the line\'s own org (journal_lines has no org_id: its org is journal_entries.org_id)' },
  { column: 'mirror_outbox.entity_id', kind: 'polymorphic', reason: 'outbox rows carry their own org_id; entity_id points at whichever table entity_type names' },
  { column: 'person_credentials.external_id', kind: 'external-key', reason: 'Firebase/IdP subject id' },
  { column: 'lobby_entries.client_request_id', kind: 'idempotency-key', reason: 'T-455: the diner phone\'s retry key for one check-in (unique per store); a minted string, not a row of ours' },
  { column: 'pos_bridge_day_checks.pos_store_id', kind: 'external-key', reason: 'T-472: POS Firestore store id string the day was read from; mapped through pos_v1_store_links, store_id carries the real composite FK' },
  { column: 'pos_bridge_receipt_lines.pos_item_id', kind: 'external-key', reason: 'T-472: POS menu item id string as POS wrote it on the receipt line; not a row of ours' },
  { column: 'pos_bridge_receipts.firestore_doc_id', kind: 'external-key', reason: 'T-472: Firestore document id of the POS receipt; the identity of the copy' },
  { column: 'pos_bridge_receipts.parent_doc_id', kind: 'external-key', reason: 'T-472: Firestore document id of the receipt a refund refunds; a POS id, may name a receipt not yet copied' },
  { column: 'pos_bridge_receipts.pos_store_id', kind: 'external-key', reason: 'T-472: POS Firestore store id string the receipt was read from; store_id carries the real composite FK' },
  { column: 'pos_terminal_links.device_id', kind: 'external-key', reason: 'the POS v2 tablet install id (a uuid minted on the device), shown on its Settings page; not a row of ours' },
  { column: 'pos_v1_day_feeds.batch_id', kind: 'idempotency-key', reason: 'T-398 S3 D2: a minted grouping id of one feed batch; no parent table exists, so there is nothing to point a foreign key at' },
  { column: 'pos_v1_day_feeds.pos_store_id', kind: 'external-key', reason: 'v1 POS store id string, mapped through pos_v1_store_links' },
  { column: 'pos_v1_store_links.pos_store_id', kind: 'external-key', reason: 'v1 POS store id string' },
  { column: 'sessions.device_id', kind: 'external-key', reason: 'device identifier string of a session' },
  { column: 'stock_layers.source_id', kind: 'polymorphic', reason: 'id of the source row named by the layer\'s source type' },
  { column: 'stock_movements.source_id', kind: 'polymorphic', reason: 'id of the source row named by the movement\'s source type' },
  { column: 'v1_master_links.v1_id', kind: 'external-key', reason: 'v1 Firestore document id' },
  { column: 'v1_master_links.v1_store_id', kind: 'external-key', reason: 'v1 store id string' },
  { column: 'v1_master_links.v2_id', kind: 'polymorphic', reason: 'uuid of the v2 row named by the link\'s entity type; carries its own org_id' },
];

export interface JsonbReference {
  readonly column: string;
  readonly kind: 'snapshot' | 'diagnostic';
  readonly reason: string;
}

/** Every jsonb column, each declared as carrying no authoritative cross-row reference (A8). */
export const JSONB_REFERENCES: readonly JsonbReference[] = [
  { column: 'audit_log.after', kind: 'snapshot', reason: 'post-change row snapshot for display; never read back as a reference' },
  { column: 'audit_log.before', kind: 'snapshot', reason: 'pre-change row snapshot for display; never read back as a reference' },
  { column: 'etl_source_documents.payload', kind: 'snapshot', reason: 'raw v1 document; no tenancy' },
  { column: 'inbox_quarantine.raw_event', kind: 'snapshot', reason: 'raw rejected inbox event kept for diagnosis' },
  { column: 'pos_usage_pull_lines.blocked', kind: 'diagnostic', reason: 'blocked-line diagnostics; not read back as a reference' },
  { column: 'dual_run_lines.per_day', kind: 'snapshot', reason: 'per-day {date, v1, v2, delta, state} comparison figures for display; holds no id and is never read back as a reference' },
  { column: 'pos_bridge_receipts.raw', kind: 'snapshot', reason: 'T-472: the copied POS receipt fields (no personal data); a faithful snapshot, never read back as a reference' },
  { column: 'pos_v1_day_feeds.payload', kind: 'snapshot', reason: 'raw v1 POS day payload' },
  { column: 'production_records.soft_warnings', kind: 'diagnostic', reason: 'warning list shown to the cook; not read back as a reference' },
  { column: 'scheduler_runs.failures', kind: 'diagnostic', reason: 'per-run failure list; not read back as a reference' },
];
