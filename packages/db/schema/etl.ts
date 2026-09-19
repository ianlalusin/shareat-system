/**
 * etl_runs + etl_source_documents + etl_quarantine + etl_reconciliation — the ETL
 * framework's own tables. docs/tasks/112-etl-framework.md.
 *
 * These four tables exist for ONE reason (task Goal): make the v1 -> v2 migration
 * re-runnable and its report trustworthy. The load-bearing decision (task's own
 * heading) is "land the raw document BEFORE converting it" — so `etl_source_documents`
 * is a durable, append-only snapshot of what Firestore said, independent of whatever
 * this repo's mapping code believes today. Everything else here exists to make that
 * landed snapshot re-processable and its outcome auditable:
 *   - `etl_runs` — the lock + ledger. One `(source_system, mode)` running at a time
 *     (Contract §3), and a run that throws is ALWAYS finalised, never left `running`.
 *   - `etl_source_documents` — append-only, content-hashed (Contract §2). No UPDATE,
 *     no DELETE, ever — a changed document is a NEW row, never an edit to the old one.
 *   - `etl_quarantine` — an unconvertible document, by a reason CODE (aggregable) plus
 *     free-text detail (Contract §4). Re-drivable: a later successful conversion
 *     RESOLVES the row rather than deleting it, so "resolved over time" is a real
 *     progress metric.
 *   - `etl_reconciliation` — one row per `(run, source_type)` (Contract §5): the
 *     framework's actual product, per the task's own words.
 *
 * None of these tables carries `org_id` or `store_id` (bible §4.2 rules 1-2's usual
 * per-row scoping). Deliberate, not an oversight: these tables describe the MIGRATION
 * ITSELF — a source system's documents, spanning every store, before any of them has
 * been resolved to a v2 org/store. The Contract's own column lists (§2-§5) name no
 * such column, and `load` mode's `orgId` is a runtime parameter to the orchestrator
 * (packages/etl/src/run.ts), not a persisted property of a run — see that file's
 * top comment.
 *
 * `id` is added to `etl_reconciliation` even though the Contract's column list opens
 * straight with `run_id` — every other table in this schema carries a surrogate `id`
 * (bible §4.2 rule 1), and `journal_entries` / `accounts` etc. all get one despite the
 * bible's own illustrative sketches not spelling it out either. Purely additive, never
 * conflicts with "one row per (run, source_type)", which is what the UNIQUE index below
 * actually enforces.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// -----------------------------------------------------------------------------------------
// etl_runs — Contract §3. The lock + ledger every mode writes through.
// -----------------------------------------------------------------------------------------

export const etlRuns = pgTable(
  'etl_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    sourceSystem: text('source_system').notNull(),
    mode: text('mode', { enum: ['capture', 'analyze', 'load'] }).notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'aborted'] })
      .notNull()
      .default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Free-text identifier of who/what started the run (a person id, a username, 'cli',
    // 'cron'...). NOT a `references(persons.id)` FK — a run can be started by tooling
    // before any person context exists, and the Contract's column list gives this no
    // further shape than a plain field. See run.ts for how it is populated.
    startedBy: text('started_by'),
    notes: text('notes'),
    error: text('error'),
  },
  (t) => [
    // Contract §3: "UNIQUE partial index on (source_system, mode) WHERE status = 'running'.
    // One run at a time." This IS the lock — a second concurrent run of the same
    // (source_system, mode) fails its INSERT immediately with a constraint violation,
    // never silently racing on landing.
    uniqueIndex('etl_runs_source_system_mode_running_unique')
      .on(t.sourceSystem, t.mode)
      .where(sql`${t.status} = 'running'`),
    index('etl_runs_source_system_mode_idx').on(t.sourceSystem, t.mode),
    check('etl_runs_mode_check', sql`${t.mode} in ('capture', 'analyze', 'load')`),
    check(
      'etl_runs_status_check',
      sql`${t.status} in ('running', 'succeeded', 'failed', 'aborted')`,
    ),
  ],
);

// -----------------------------------------------------------------------------------------
// etl_source_documents — Contract §2. Append-only, content-hashed landing.
// -----------------------------------------------------------------------------------------

export const etlSourceDocuments = pgTable(
  'etl_source_documents',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // The run that landed THIS VERSION — not necessarily the first version of this
    // doc_path (a later run landing a changed document references itself here, not the
    // run that landed the earlier version). onDelete restrict: a run is never deleted
    // out from under the rows it produced (bible §4.2 rule 3 / rule 9 — append-only).
    runId: uuid('run_id')
      .notNull()
      .references(() => etlRuns.id, { onDelete: 'restrict' }),
    sourceSystem: text('source_system').notNull(),
    collectionPath: text('collection_path').notNull(),
    docPath: text('doc_path').notNull(),
    docId: text('doc_id').notNull(),
    storeCode: text('store_code'),
    payload: jsonb('payload').notNull(),
    // sha256 hex over CANONICAL json (sorted keys, stable number formatting) — see
    // packages/db/src/repo/etl.ts `canonicalJson`/`contentHashOf`. Two serialisations of
    // the same document that differ only in key order MUST hash identically, or landing
    // would manufacture a phantom "the source changed" finding on every run (task's own
    // warning, Contract §2).
    contentHash: text('content_hash').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Contract §2's actual rule: landing the IDENTICAL document twice is a no-op;
    // landing a CHANGED one inserts a second row. This unique index is what makes
    // "no-op" a database fact (ON CONFLICT DO NOTHING against it) rather than an
    // application promise.
    uniqueIndex('etl_source_documents_identity_unique').on(
      t.sourceSystem,
      t.docPath,
      t.contentHash,
    ),
    // "Current" for a doc_path = the row with the greatest captured_at (Contract §2) —
    // resolved by a query (packages/db/src/repo/etl.ts `findCurrentDocuments` /
    // `findCurrentDocument`, using selectDistinctOn), never a maintained `is_current`
    // flag (bible §4.2 rule 7). This index is what makes that query cheap.
    index('etl_source_documents_doc_path_idx').on(t.sourceSystem, t.docPath, t.capturedAt),
    index('etl_source_documents_run_id_idx').on(t.runId),
    index('etl_source_documents_collection_path_idx').on(t.sourceSystem, t.collectionPath),
    // NOTE: "the framework never UPDATEs or DELETEs a landed row" (invariant 5) is
    // enforced by CONVENTION — no repo function here ever issues one — not by a
    // database trigger. Unlike journal_entries' posted-immutability (which must hold
    // against ANY writer, since the ledger's whole audit trail depends on it), this
    // table has exactly one writer (packages/db/src/repo/etl.ts), and Contract §2 does
    // not ask for a hand-added trigger the way T-103/T-118 did for cross-table rules
    // this file's builder cannot express. See the task report for this recorded choice.
  ],
);

// -----------------------------------------------------------------------------------------
// etl_quarantine — Contract §4. Re-drivable, not duplicated.
// -----------------------------------------------------------------------------------------

export const etlQuarantine = pgTable(
  'etl_quarantine',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // The run that most recently touched this row — the run that CREATED it (paired
    // with first_seen_at) or, for a still-open row, the run whose failed re-conversion
    // attempt this row's last_seen_at advance belongs to. See
    // packages/db/src/repo/etl.ts `quarantineDocument` for the exact ON CONFLICT
    // semantics this implements.
    runId: uuid('run_id')
      .notNull()
      .references(() => etlRuns.id, { onDelete: 'restrict' }),
    sourceSystem: text('source_system').notNull(),
    docPath: text('doc_path').notNull(),
    // The business document kind ('sale' | 'expense' | ...) — the same vocabulary as
    // journal_entries.source_type. Supplied by the caller's Converter (T-112 "builds no
    // mapping" — see packages/etl/src/reconcile.ts's top comment for why this framework
    // never invents that vocabulary itself).
    sourceType: text('source_type').notNull(),
    // The T-117 taxonomy case class, when known ('sale.branch_sale', ...). Nullable —
    // a document that fails classification itself has no case class yet.
    caseClass: text('case_class'),
    // Contract §4: "reason_code is an enumerated string; reason_detail is the free
    // text." Deliberately NOT a Postgres enum or a CHECK ... IN (...) list here — the
    // vocabulary of reason codes belongs to whoever supplies the Converter (T-113/T-114
    // territory), and T-112 does not own or guess it (bible §11 rule 5 — never guess a
    // mapping). See the task report for this as a recorded scope boundary.
    reasonCode: text('reason_code').notNull(),
    reasonDetail: text('reason_detail').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedRunId: uuid('resolved_run_id').references(() => etlRuns.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // Contract §4: "UNIQUE (source_system, doc_path, reason_code) WHERE resolved_at IS
    // NULL." At most one OPEN quarantine row per (doc, reason) — a still-unconvertible
    // document advances last_seen_at on this row (ON CONFLICT ... DO UPDATE) instead of
    // inserting a duplicate. A RESOLVED row never conflicts with a new one for the same
    // (doc, reason), which is exactly what lets a doc quarantine, resolve, and
    // quarantine again for the same reason across the document's history.
    uniqueIndex('etl_quarantine_open_unique')
      .on(t.sourceSystem, t.docPath, t.reasonCode)
      .where(sql`${t.resolvedAt} is null`),
    // Contract §4's own worked example ("880 unmapped_expense_category, 407
    // unbalanced_source_group...") IS a `GROUP BY reason_code` — this index is what
    // makes that aggregate cheap at audit-report scale (invariant 11).
    index('etl_quarantine_reason_code_idx').on(t.reasonCode),
    index('etl_quarantine_run_id_idx').on(t.runId),
    index('etl_quarantine_doc_path_idx').on(t.sourceSystem, t.docPath),
  ],
);

// -----------------------------------------------------------------------------------------
// etl_reconciliation — Contract §5. One row per (run, source_type).
// -----------------------------------------------------------------------------------------

export const etlReconciliation = pgTable(
  'etl_reconciliation',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => etlRuns.id, { onDelete: 'restrict' }),
    // capture-mode rows: the collection_path being reconciled (capture never learns a
    // document's BUSINESS type, only where it came from). analyze/load-mode rows: the
    // Converter's declared source_type ('sale' | 'expense' | ...). See run.ts's top
    // comment — this is a documented interpretation, not spelled out further by the
    // Contract's own column list.
    sourceType: text('source_type').notNull(),
    // Always populated. capture: documents actually read from the SourceReader.
    // analyze/load: documents read back from etl_source_documents (== landedCount by
    // construction, since neither mode touches the source — Contract §6's "analyze
    // must run offline").
    sourceCount: integer('source_count').notNull(),
    landedCount: integer('landed_count').notNull(),
    // NULL for a capture-mode row (capture does not classify or convert anything —
    // Contract §6). Populated for analyze/load.
    convertedCount: integer('converted_count'),
    skippedCount: integer('skipped_count'),
    quarantinedCount: integer('quarantined_count'),
    // 0 by default (capture and analyze both post nothing); load sets the real count.
    entriesPosted: integer('entries_posted').notNull().default(0),
    // Contract §5: "Recorded, never gated." NULL for capture (it never reads a document
    // well enough to know its headline amount).
    sourceAmountTotal: numeric('source_amount_total', { precision: 14, scale: 2 }),
    debitTotal: numeric('debit_total', { precision: 14, scale: 2 }),
    creditTotal: numeric('credit_total', { precision: 14, scale: 2 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "One row per (run, source_type)" (Contract §5) — the actual constraint, not just
    // a description. packages/db/src/repo/etl.ts's writeReconciliation is called at
    // most once per (run, source_type) by construction; this is the backstop.
    uniqueIndex('etl_reconciliation_run_id_source_type_unique').on(t.runId, t.sourceType),
    index('etl_reconciliation_source_type_idx').on(t.sourceType),
    // Cheap, uncontroversial hygiene (matching journal_lines_amounts_nonnegative_check's
    // precedent) — not a re-implementation of the HARD cross-column invariants
    // ("converted+skipped+quarantined=landed", "debit_total=credit_total in load mode").
    // Those stay in packages/etl/src/reconcile.ts, tested there directly with no
    // database (task Scope's own file layout: reconcile.test.ts is a unit test) — see
    // that file's top comment for why a database CHECK is NOT the right layer for them
    // here, unlike journal_entries' balance trigger.
    check('etl_reconciliation_source_count_nonnegative_check', sql`${t.sourceCount} >= 0`),
    check('etl_reconciliation_landed_count_nonnegative_check', sql`${t.landedCount} >= 0`),
    check(
      'etl_reconciliation_converted_count_nonnegative_check',
      sql`${t.convertedCount} is null or ${t.convertedCount} >= 0`,
    ),
    check(
      'etl_reconciliation_skipped_count_nonnegative_check',
      sql`${t.skippedCount} is null or ${t.skippedCount} >= 0`,
    ),
    check(
      'etl_reconciliation_quarantined_count_nonnegative_check',
      sql`${t.quarantinedCount} is null or ${t.quarantinedCount} >= 0`,
    ),
    check('etl_reconciliation_entries_posted_nonnegative_check', sql`${t.entriesPosted} >= 0`),
    check('etl_reconciliation_source_amount_total_finite_check', sql`${t.sourceAmountTotal} > '-Infinity'::numeric and ${t.sourceAmountTotal} < 'Infinity'::numeric`),
    check('etl_reconciliation_debit_total_finite_check', sql`${t.debitTotal} > '-Infinity'::numeric and ${t.debitTotal} < 'Infinity'::numeric`),
    check('etl_reconciliation_credit_total_finite_check', sql`${t.creditTotal} > '-Infinity'::numeric and ${t.creditTotal} < 'Infinity'::numeric`),
  ],
);
