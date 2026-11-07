-- 0243 - T-511 S6b: the append-only record of a platform sales correction, and the dual-run class PLATFORM_FILE_CORRECTION.
-- docs/tasks/511-settlement-upload-s6-spec.md "S6b" (migration bullet); hand-authored per ADR-012 s5. Journal idx 243 (provisional, BOSS sets the final number at rebase time).
--
-- WHY. A delivery platform's file figure is the truth for a day's sales and receivable (design decision 17, option B). Staff typed a figure, the day was verified and its
-- entry posted, and that entry is never edited. `correctPlatformSales` posts the DIFFERENCE as a new entry (Dr 1220 / Cr 4150 when the file is higher, the other way round when
-- lower) and writes ONE row here per staged day line: the figure the books held (from_amount: the staff entry plus earlier corrections), the file figure (to_amount), the date
-- the entry was posted on, and why. `sales_day_channels.amount` is never overwritten.
--
-- SHAPE. sales_day_platform_corrections (id, org_id, store_id, sales_day_id, channel_id, day_line_id, from_amount, to_amount, entry_date, journal_entry_id, reason, posted_by,
-- posted_at), every column NOT NULL. Unique (org_id, sales_day_id, day_line_id): one correction per staged line PER SALES DAY (the idempotency anchor; a voided day
-- re-entered on the same date is a new sales day and its line may be corrected again). Unique (org_id, journal_entry_id): one entry backs one correction. reason non-blank;
-- both amounts finite (t327); from_amount <> to_amount (a correction that moves nothing is never written).
-- FOREIGN KEYS: composite-only same-org twins (org_id, x) onto the (org_id, id) uniques of stores (0194), persons (0194), sales_days (0213), sales_channels (0213),
-- journal_entries (0213) and settlement_day_lines (0228), all ON DELETE RESTRICT (t398 C1: never a bare single-column FK).
-- RLS and GRANTS (ADR-012 s5 rules 4 and 4a): ENABLE + FORCE, policy sales_day_platform_corrections_org_isolation on app_current_org() in USING and WITH CHECK; the app role
-- gets SELECT and INSERT only. APPEND-ONLY: a BEFORE UPDATE OR DELETE refuse trigger, ENABLE ALWAYS (T-354 / DEF-487), house pattern 0183 sales_day_pos_corrections.
-- DUAL-RUN. dual_run_lines_class_check (0195) lists 23 codes; this migration drops and re-adds it with the same 23 plus PLATFORM_FILE_CORRECTION, copied by hand.
--
-- LOCK BUDGET. dual_run_lines is small (reports of a few weeks). First statement SET LOCAL lock_timeout = '5s' (resets at commit). Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "sales_day_platform_corrections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"day_line_id" uuid NOT NULL,
	"from_amount" numeric(14,2) NOT NULL,
	"to_amount" numeric(14,2) NOT NULL,
	"entry_date" date NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_day_platform_corrections_day_and_line_unique" UNIQUE ("org_id", "sales_day_id", "day_line_id"),
	CONSTRAINT "sales_day_platform_corrections_journal_entry_unique" UNIQUE ("org_id", "journal_entry_id"),
	CONSTRAINT "sales_day_platform_corrections_amounts_differ_check" CHECK ("from_amount" <> "to_amount"),
	CONSTRAINT "sales_day_platform_corrections_reason_not_blank_check" CHECK (btrim("reason") <> ''),
	CONSTRAINT "sales_day_platform_corrections_from_amount_finite_check" CHECK ("from_amount" > '-Infinity'::numeric AND "from_amount" < 'Infinity'::numeric),
	CONSTRAINT "sales_day_platform_corrections_to_amount_finite_check" CHECK ("to_amount" > '-Infinity'::numeric AND "to_amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_sales_day_id_same_org_fk" FOREIGN KEY ("org_id", "sales_day_id") REFERENCES "public"."sales_days"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_channel_id_same_org_fk" FOREIGN KEY ("org_id", "channel_id") REFERENCES "public"."sales_channels"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_day_line_id_same_org_fk" FOREIGN KEY ("org_id", "day_line_id") REFERENCES "public"."settlement_day_lines"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "public"."journal_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ADD CONSTRAINT "sales_day_platform_corrections_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- append-only, ENABLE ALWAYS (T-354 / DEF-487) so session_replication_role = replica cannot switch it off. The cutover purge uses TRUNCATE, which a row trigger does not see.
CREATE FUNCTION "sales_day_platform_corrections_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A platform sales correction is never changed or removed (% on row % is refused). A wrong correction is itself corrected by a new row, and a void of the day reverses its entry.',
		TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "sales_day_platform_corrections_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "sales_day_platform_corrections_append_only"
	BEFORE UPDATE OR DELETE ON "sales_day_platform_corrections"
	FOR EACH ROW EXECUTE FUNCTION "sales_day_platform_corrections_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" ENABLE ALWAYS TRIGGER "sales_day_platform_corrections_append_only";
--> statement-breakpoint

ALTER TABLE "sales_day_platform_corrections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales_day_platform_corrections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sales_day_platform_corrections_org_isolation" ON "sales_day_platform_corrections" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "sales_day_platform_corrections" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "sales_day_platform_corrections" TO "shareat_app";
--> statement-breakpoint

-- dual-run: the 23 codes of 0195 plus PLATFORM_FILE_CORRECTION
ALTER TABLE "dual_run_lines" DROP CONSTRAINT "dual_run_lines_class_check";
--> statement-breakpoint
ALTER TABLE "dual_run_lines" ADD CONSTRAINT "dual_run_lines_class_check" CHECK ("class" in (
	'TIES','INVENTORY_BASIS','PAYROLL_ON_V1','NOT_IN_DUAL_RUN_SCOPE','V2_ONLY_EVENT','V1_CASH_RESIDUAL','AP_AT_INVOICE',
	'SUPPLIER_ADVANCE_1240','V2_CORRECTION_DATED_LATER','CHANNEL_AR_FLOW','PENDING_V2','PENDING_V1','DATE_SHIFT',
	'NOT_DOUBLE_ENTERED','KEYING_DIFFERENCE','MISCLASSIFIED','UNMAPPED_KEY','V1_DEFECT','V2_DEFECT','UNEXPLAINED',
	'V1_REMITTED_FIELD_ZERO','V1_UNKNOWN_EXPENSE_GROUP','V1_EXPENSE_ENTRY_GROUP_CONFLICT','PLATFORM_FILE_CORRECTION'));
