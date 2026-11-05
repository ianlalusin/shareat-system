-- 0236 - T-519 S1: a staff charge is recovered from pay only under a signed deduction agreement (DEF-813).
-- docs/tasks/519-staff-deduction-agreements.md (R1-R6, S1); hand-authored per ADR-012 s5. Journal idx 236 (renumbered from 0234 by BOSS, 5 Nov: T-510 S2 took 0234).
--
-- WHY. Labor Code Art. 113 and Omnibus Rules Book III Rule VIII s.14: a deduction for loss or damage needs the employee's clear responsibility, a chance
-- to show cause, a fair amount, and at most 20% of a week's wages. Until now payroll netted the person's WHOLE 1230 balance every run. After this migration
-- payroll, 13th month and separation recover only what an ACTIVE agreement covers (domain: payroll/deduction-agreements.ts). The charge itself stays a
-- receivable on 1230 (R1); this migration only adds the places to PUT the agreement and the per-run recoveries taken under it.
--
-- SHAPE.
--   stored_files_purpose_check          widened with 'staff_deduction_agreement' (0204 / 0228 pattern: DROP, ADD NOT VALID, VALIDATE).
--   staff_deduction_agreements          one row per signed agreement (R2). Append-only apart from status and its stamps.
--   staff_deduction_recoveries          one row per (agreement, payroll journal entry): how much of that entry's 1230 credit the agreement covered.
--                                       ADDED BEYOND R2 (reported to BOSS): the app role cannot UPDATE a money column and the agreement must be able to
--                                       reopen on a void (R6), so what was recovered is derived from these rows joined to journal_entries.status
--                                       ('posted' counts; a voided run's entry is 'reversed' and stops counting). Append-only: no UPDATE, no DELETE.
--
-- ONE ACTIVE AGREEMENT PER CHARGE. staff_deduction_agreements_active_charge_key: UNIQUE (org_id, source_entry_id) WHERE status = 'active'.
-- CHECK amount <= the charge is enforced in the domain (it needs the ledger), as is the recorder never being the charged person (R4) and R5.
--
-- MONEY. numeric(14,2), a <table>_<column>_finite_check of the exact body the t327 census compares and a _positive_check. Never updatable in place.
-- FOREIGN KEYS. Composite same-org twins only (org_id, col) -> parent (org_id, id) (t398 C1). staff_deduction_agreements is an FK target: one inline UNIQUE (org_id, id) (K2).
-- RLS and GRANTS (ADR-012 s5 rules 4 and 4a). ENABLE + FORCE RLS and <table>_org_isolation (app_current_org()). The app role gets SELECT and INSERT; on the agreements
-- also COLUMN-LEVEL UPDATE on status, completed_at, cancelled_at, cancelled_by, cancel_reason only (precedent 0228). No DELETE, no TRUNCATE.
-- LOCK BUDGET. stored_files is small; the purpose CHECK is added NOT VALID and validated in a second statement. First statement SET LOCAL lock_timeout = '5s'.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 1. stored_files: the purpose of the scan of a signed agreement (9 current values from 0228 + 'staff_deduction_agreement')
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_purpose_check";
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purpose_check" CHECK ("purpose" IN ('receipt_photo', 'ar_collection_proof', 'memo_document', 'wastage_dispute', 'onboarding_document', 'staff_photo', 'staff_signature', 'leave_document', 'channel_settlement_file', 'staff_deduction_agreement')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "stored_files" VALIDATE CONSTRAINT "stored_files_purpose_check";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. staff_deduction_agreements
CREATE TABLE "staff_deduction_agreements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_entry_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"per_payroll_limit" numeric(14,2) NOT NULL,
	"notice_given_at" date NOT NULL,
	"employee_explanation" text NOT NULL,
	"signed_on" date NOT NULL,
	"evidence_file_id" uuid,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "staff_deduction_agreements_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "staff_deduction_agreements_source_type_check" CHECK ("source_type" IN ('cash_request_shortage', 'tillcountshortage', 'remittance_variance', 'trade_discrepancy', 'order_wastage', 'owner_pay_recovery')),
	CONSTRAINT "staff_deduction_agreements_status_check" CHECK ("status" IN ('active', 'completed', 'cancelled')),
	CONSTRAINT "staff_deduction_agreements_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "staff_deduction_agreements_per_payroll_limit_positive_check" CHECK ("per_payroll_limit" > 0),
	CONSTRAINT "staff_deduction_agreements_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric),
	CONSTRAINT "staff_deduction_agreements_per_payroll_limit_finite_check" CHECK ("per_payroll_limit" > '-Infinity'::numeric AND "per_payroll_limit" < 'Infinity'::numeric),
	CONSTRAINT "staff_deduction_agreements_notice_before_signed_check" CHECK ("notice_given_at" <= "signed_on"),
	CONSTRAINT "staff_deduction_agreements_explanation_not_blank_check" CHECK (length(trim("employee_explanation")) > 0),
	CONSTRAINT "staff_deduction_agreements_status_stamps_check" CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL) AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_source_entry_id_same_org_fk" FOREIGN KEY ("org_id", "source_entry_id") REFERENCES "public"."journal_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_evidence_file_id_same_org_fk" FOREIGN KEY ("org_id", "evidence_file_id") REFERENCES "public"."stored_files"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_recorded_by_same_org_fk" FOREIGN KEY ("org_id", "recorded_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" ADD CONSTRAINT "staff_deduction_agreements_cancelled_by_same_org_fk" FOREIGN KEY ("org_id", "cancelled_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_deduction_agreements_active_charge_key" ON "staff_deduction_agreements" ("org_id", "source_entry_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "staff_deduction_agreements_org_person_idx" ON "staff_deduction_agreements" ("org_id", "person_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. staff_deduction_recoveries: what each payroll journal entry recovered under which agreement
CREATE TABLE "staff_deduction_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_deduction_recoveries_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "staff_deduction_recoveries_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "staff_deduction_recoveries" ADD CONSTRAINT "staff_deduction_recoveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_recoveries" ADD CONSTRAINT "staff_deduction_recoveries_agreement_id_same_org_fk" FOREIGN KEY ("org_id", "agreement_id") REFERENCES "public"."staff_deduction_agreements"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "staff_deduction_recoveries" ADD CONSTRAINT "staff_deduction_recoveries_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "public"."journal_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_deduction_recoveries_agreement_entry_key" ON "staff_deduction_recoveries" ("org_id", "agreement_id", "journal_entry_id");
--> statement-breakpoint
CREATE INDEX "staff_deduction_recoveries_org_entry_idx" ON "staff_deduction_recoveries" ("org_id", "journal_entry_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ---------------------------------------------------------------------------------------------
-- 4. RLS (ADR-012 s5 rule 4)
ALTER TABLE "staff_deduction_agreements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "staff_deduction_agreements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "staff_deduction_agreements_org_isolation" ON "staff_deduction_agreements" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "staff_deduction_recoveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "staff_deduction_recoveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "staff_deduction_recoveries_org_isolation" ON "staff_deduction_recoveries" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. Grants (ADR-012 s5 rule 4a)
GRANT SELECT, INSERT ON "staff_deduction_agreements", "staff_deduction_recoveries" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("status", "completed_at", "cancelled_at", "cancelled_by", "cancel_reason") ON "staff_deduction_agreements" TO "shareat_app";
