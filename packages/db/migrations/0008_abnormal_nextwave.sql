-- 0008 — T-112 (docs/tasks/112-etl-framework.md): the ETL framework's own four tables —
-- etl_runs (the run ledger + one-running-per-mode lock), etl_source_documents (append-only,
-- content-hashed landing — the "land before you convert" decision the task spec is built
-- around), etl_quarantine (re-drivable, reason-coded), etl_reconciliation (one row per
-- (run, source_type), the framework's actual product per the task's own words).
--
-- Entirely generated from schema/etl.ts — no hand-added triggers this time, unlike 0003-0007.
-- Every rule the Contract asks for here (the running-lock, the landing identity, the open-
-- quarantine identity, "one row per (run, source_type)") is expressible as a plain UNIQUE /
-- partial UNIQUE index or a per-row CHECK, because none of them needs to look at another
-- table the way journal_lines' account-eligibility or party-requirement checks do. The two
-- HARD cross-column reconciliation invariants (converted+skipped+quarantined=landed;
-- debit_total=credit_total in load mode) are deliberately NOT database CHECK constraints —
-- see packages/etl/src/reconcile.ts's top comment for why that logic stays in TypeScript,
-- tested with no database, for this table specifically.
--
-- DEF-039 (bible §13 row 99): generated `when` is 1787493293449, verified strictly after
-- 0007's hand-picked 1787492000000 by packages/db/tests/migration-journal.test.ts BEFORE
-- this migration was used for anything else. Verified, not assumed.
--
-- 0000-0007 are already applied and are therefore never edited (bible §2 rule 8).
CREATE TABLE "etl_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"doc_path" text NOT NULL,
	"source_type" text NOT NULL,
	"case_class" text,
	"reason_code" text NOT NULL,
	"reason_detail" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "etl_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_count" integer NOT NULL,
	"landed_count" integer NOT NULL,
	"converted_count" integer,
	"skipped_count" integer,
	"quarantined_count" integer,
	"entries_posted" integer DEFAULT 0 NOT NULL,
	"source_amount_total" numeric(14, 2),
	"debit_total" numeric(14, 2),
	"credit_total" numeric(14, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etl_reconciliation_source_count_nonnegative_check" CHECK ("etl_reconciliation"."source_count" >= 0),
	CONSTRAINT "etl_reconciliation_landed_count_nonnegative_check" CHECK ("etl_reconciliation"."landed_count" >= 0),
	CONSTRAINT "etl_reconciliation_converted_count_nonnegative_check" CHECK ("etl_reconciliation"."converted_count" is null or "etl_reconciliation"."converted_count" >= 0),
	CONSTRAINT "etl_reconciliation_skipped_count_nonnegative_check" CHECK ("etl_reconciliation"."skipped_count" is null or "etl_reconciliation"."skipped_count" >= 0),
	CONSTRAINT "etl_reconciliation_quarantined_count_nonnegative_check" CHECK ("etl_reconciliation"."quarantined_count" is null or "etl_reconciliation"."quarantined_count" >= 0),
	CONSTRAINT "etl_reconciliation_entries_posted_nonnegative_check" CHECK ("etl_reconciliation"."entries_posted" >= 0)
);
--> statement-breakpoint
CREATE TABLE "etl_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source_system" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"started_by" text,
	"notes" text,
	"error" text,
	CONSTRAINT "etl_runs_mode_check" CHECK ("etl_runs"."mode" in ('capture', 'analyze', 'load')),
	CONSTRAINT "etl_runs_status_check" CHECK ("etl_runs"."status" in ('running', 'succeeded', 'failed', 'aborted'))
);
--> statement-breakpoint
CREATE TABLE "etl_source_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"collection_path" text NOT NULL,
	"doc_path" text NOT NULL,
	"doc_id" text NOT NULL,
	"store_code" text,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "etl_quarantine" ADD CONSTRAINT "etl_quarantine_run_id_etl_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."etl_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etl_quarantine" ADD CONSTRAINT "etl_quarantine_resolved_run_id_etl_runs_id_fk" FOREIGN KEY ("resolved_run_id") REFERENCES "public"."etl_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etl_reconciliation" ADD CONSTRAINT "etl_reconciliation_run_id_etl_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."etl_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etl_source_documents" ADD CONSTRAINT "etl_source_documents_run_id_etl_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."etl_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "etl_quarantine_open_unique" ON "etl_quarantine" USING btree ("source_system","doc_path","reason_code") WHERE "etl_quarantine"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "etl_quarantine_reason_code_idx" ON "etl_quarantine" USING btree ("reason_code");--> statement-breakpoint
CREATE INDEX "etl_quarantine_run_id_idx" ON "etl_quarantine" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "etl_quarantine_doc_path_idx" ON "etl_quarantine" USING btree ("source_system","doc_path");--> statement-breakpoint
CREATE UNIQUE INDEX "etl_reconciliation_run_id_source_type_unique" ON "etl_reconciliation" USING btree ("run_id","source_type");--> statement-breakpoint
CREATE INDEX "etl_reconciliation_source_type_idx" ON "etl_reconciliation" USING btree ("source_type");--> statement-breakpoint
CREATE UNIQUE INDEX "etl_runs_source_system_mode_running_unique" ON "etl_runs" USING btree ("source_system","mode") WHERE "etl_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "etl_runs_source_system_mode_idx" ON "etl_runs" USING btree ("source_system","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "etl_source_documents_identity_unique" ON "etl_source_documents" USING btree ("source_system","doc_path","content_hash");--> statement-breakpoint
CREATE INDEX "etl_source_documents_doc_path_idx" ON "etl_source_documents" USING btree ("source_system","doc_path","captured_at");--> statement-breakpoint
CREATE INDEX "etl_source_documents_run_id_idx" ON "etl_source_documents" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "etl_source_documents_collection_path_idx" ON "etl_source_documents" USING btree ("source_system","collection_path");