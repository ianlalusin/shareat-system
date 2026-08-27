-- 0030 — T-143: pooled remittance. One handover settling many days.
-- Bible rows 128–129, 144–147. Hand-written for the RLS policies.
--
-- ## ⭐ A remittance IS a transfer, with allocations attached
--
-- The money movement already exists (T-139): cashier-custodian account to office-custodian
-- account, same store. NOTHING HERE POSTS TO THE LEDGER. remittance_lines.money_transfer_id is
-- the seam that keeps one money-movement path — ⛔ do not grow a second one, which is exactly how
-- v1 ended up with two amortisation runners that drifted apart.
--
-- ## ⛔ No expected column, no total column, no partially_remitted status
--
-- sales_days' own header forbids the last one by name: "do not add actualRemittanceCash,
-- remittanceRefNo or a partially_remitted status here; that is precisely the shape that blocks
-- pooling." The state keeps v1's word and is DERIVED from what has been allocated.

--> statement-breakpoint
CREATE TABLE "remittances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"remitted_on" date NOT NULL,
	"reference" text,
	"notes" text,
	-- Who RECEIVED it. The accountability that matters is the acceptance — that is the moment
	-- custody changes hands.
	"accepted_by" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"reversed_on" date,
	"reverse_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittances_status_check" CHECK ("remittances"."status" in ('posted', 'reversed')),
	CONSTRAINT "remittances_reverse_shape_check" CHECK (("remittances"."status" = 'reversed') = ("remittances"."reversed_on" is not null and "remittances"."reverse_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "remittance_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"remittance_id" uuid NOT NULL,
	"from_money_account_id" uuid NOT NULL,
	"to_money_account_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	-- ⭐ THE SEAM. One posting path, one place the legs live.
	"money_transfer_id" uuid NOT NULL,
	CONSTRAINT "remittance_lines_amount_positive_check" CHECK ("remittance_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "remittance_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"remittance_id" uuid NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "remittance_allocations_amount_positive_check" CHECK ("remittance_allocations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "remittance_variances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"remittance_id" uuid NOT NULL,
	-- Where FIFO left the residual. ⛔ NOT a statement about who owes it.
	"sales_day_id" uuid NOT NULL,
	-- SIGNED: negative short, positive over. One column, because they are one event seen from two
	-- directions, and splitting them invites a report that shows only the shorts.
	"amount" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"charged_to_person_id" uuid,
	"reason" text,
	"resolved_by" uuid,
	"resolved_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_variances_amount_nonzero_check" CHECK ("remittance_variances"."amount" <> 0),
	CONSTRAINT "remittance_variances_status_check" CHECK ("remittance_variances"."status" in ('open', 'charged', 'written_off')),
	-- ⛔ THE REFUSAL, in the schema so no code path can skip it. v1's remittance builder throws
	-- rather than infer a chargeToStaffId; inferring the person from the DATE is exactly the wrong
	-- inference (bible row 128), because FIFO put the residual there — not the person.
	CONSTRAINT "remittance_variances_resolution_shape_check" CHECK (
		("remittance_variances"."status" = 'open' and "remittance_variances"."charged_to_person_id" is null and "remittance_variances"."resolved_by" is null)
		or ("remittance_variances"."status" = 'charged' and "remittance_variances"."charged_to_person_id" is not null and "remittance_variances"."resolved_by" is not null)
		or ("remittance_variances"."status" = 'written_off' and "remittance_variances"."reason" is not null and "remittance_variances"."resolved_by" is not null)
	)
);
--> statement-breakpoint

ALTER TABLE "remittances" ADD CONSTRAINT "remittances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_accepted_by_persons_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_from_money_account_id_money_accounts_id_fk" FOREIGN KEY ("from_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_to_money_account_id_money_accounts_id_fk" FOREIGN KEY ("to_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_money_transfer_id_money_transfers_id_fk" FOREIGN KEY ("money_transfer_id") REFERENCES "public"."money_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_sales_day_id_sales_days_id_fk" FOREIGN KEY ("sales_day_id") REFERENCES "public"."sales_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_sales_day_id_sales_days_id_fk" FOREIGN KEY ("sales_day_id") REFERENCES "public"."sales_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_charged_to_person_id_persons_id_fk" FOREIGN KEY ("charged_to_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_resolved_by_persons_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "remittances_org_store_date_idx" ON "remittances" ("org_id","store_id","remitted_on");--> statement-breakpoint
CREATE INDEX "remittance_lines_remittance_idx" ON "remittance_lines" ("remittance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remittance_lines_transfer_unique" ON "remittance_lines" ("money_transfer_id");--> statement-breakpoint
CREATE INDEX "remittance_allocations_sales_day_idx" ON "remittance_allocations" ("sales_day_id");--> statement-breakpoint
-- ⚠️ One batch settles a given day once. Two rows for the same pair would double-count the day's
-- settlement and quietly mark it fully remitted.
CREATE UNIQUE INDEX "remittance_allocations_unique" ON "remittance_allocations" ("remittance_id","sales_day_id");--> statement-breakpoint
CREATE INDEX "remittance_variances_org_status_idx" ON "remittance_variances" ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "remittance_variances_remittance_unique" ON "remittance_variances" ("remittance_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- RLS. The two child tables have no org_id and are scoped through their handover, so the two
-- can never disagree about which org they belong to.
-- ---------------------------------------------------------------------------------------
ALTER TABLE "remittances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "remittances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittances_org_isolation" ON "remittances" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "remittance_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "remittance_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_lines_org_isolation" ON "remittance_lines" FOR ALL
	USING (exists (select 1 from remittances r where r.id = remittance_lines.remittance_id and r.org_id = app_current_org()))
	WITH CHECK (exists (select 1 from remittances r where r.id = remittance_lines.remittance_id and r.org_id = app_current_org()));--> statement-breakpoint

ALTER TABLE "remittance_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "remittance_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_allocations_org_isolation" ON "remittance_allocations" FOR ALL
	USING (exists (select 1 from remittances r where r.id = remittance_allocations.remittance_id and r.org_id = app_current_org()))
	WITH CHECK (exists (select 1 from remittances r where r.id = remittance_allocations.remittance_id and r.org_id = app_current_org()));--> statement-breakpoint

ALTER TABLE "remittance_variances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "remittance_variances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "remittance_variances_org_isolation" ON "remittance_variances" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
