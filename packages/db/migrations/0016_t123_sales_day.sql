CREATE TABLE "sales_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_remitted_daily" boolean NOT NULL,
	"receivable_account_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "sales_channels_non_remitted_needs_receivable_check" CHECK ("sales_channels"."is_remitted_daily" = true or "sales_channels"."receivable_account_code" is not null)
);
--> statement-breakpoint
CREATE TABLE "sales_day_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"no_sales" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sales_day_channels_amount_non_negative_check" CHECK ("sales_day_channels"."amount" >= 0),
	CONSTRAINT "sales_day_channels_no_sales_is_zero_check" CHECK ("sales_day_channels"."no_sales" = false or "sales_day_channels"."amount" = 0)
);
--> statement-breakpoint
CREATE TABLE "sales_days" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"pos_sourced" boolean DEFAULT false NOT NULL,
	"pos_sourced_at" timestamp with time zone,
	"total_sales" numeric(14, 2) NOT NULL,
	"unli_sales" numeric(14, 2) NOT NULL,
	"ala_carte_sales" numeric(14, 2) NOT NULL,
	"senior_discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"pwd_discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"other_discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"comps" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cash_collected" numeric(14, 2) DEFAULT '0' NOT NULL,
	"online_collected" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit_sales" numeric(14, 2) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "sales_days_status_check" CHECK ("sales_days"."status" in ('open', 'submitted', 'verified', 'voided')),
	CONSTRAINT "sales_days_non_negative_check" CHECK (
      "sales_days"."total_sales" >= 0 and "sales_days"."unli_sales" >= 0 and "sales_days"."ala_carte_sales" >= 0
      and "sales_days"."senior_discount" >= 0 and "sales_days"."pwd_discount" >= 0 and "sales_days"."other_discount" >= 0
      and "sales_days"."comps" >= 0
      and "sales_days"."cash_collected" >= 0 and "sales_days"."online_collected" >= 0 and "sales_days"."credit_sales" >= 0
    ),
	CONSTRAINT "sales_days_revenue_identity_check" CHECK (
      "sales_days"."unli_sales" + "sales_days"."ala_carte_sales" = "sales_days"."total_sales"
    ),
	CONSTRAINT "sales_days_pos_sourced_check" CHECK (
      ("sales_days"."pos_sourced" = false and "sales_days"."pos_sourced_at" is null)
      or ("sales_days"."pos_sourced" = true and "sales_days"."pos_sourced_at" is not null)
    )
);
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_day_channels" ADD CONSTRAINT "sales_day_channels_sales_day_id_sales_days_id_fk" FOREIGN KEY ("sales_day_id") REFERENCES "public"."sales_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_day_channels" ADD CONSTRAINT "sales_day_channels_channel_id_sales_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_submitted_by_persons_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_verified_by_persons_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channels_org_id_store_id_name_unique" ON "sales_channels" USING btree ("org_id","store_id","name");--> statement-breakpoint
CREATE INDEX "sales_channels_org_id_store_id_idx" ON "sales_channels" USING btree ("org_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_day_channels_sales_day_id_channel_id_unique" ON "sales_day_channels" USING btree ("sales_day_id","channel_id");--> statement-breakpoint
CREATE INDEX "sales_day_channels_channel_id_idx" ON "sales_day_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_days_org_id_store_id_business_date_unique" ON "sales_days" USING btree ("org_id","store_id","business_date");--> statement-breakpoint
CREATE INDEX "sales_days_org_id_business_date_idx" ON "sales_days" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "sales_days_org_id_store_id_status_business_date_idx" ON "sales_days" USING btree ("org_id","store_id","status","business_date");--> statement-breakpoint
CREATE INDEX "sales_days_status_idx" ON "sales_days" USING btree ("status");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Row Level Security — hand-written, because drizzle-kit does not generate policies.
-- Same three-part shape as migration 0015: ENABLE + FORCE + one policy per table, matching
-- packages/db/src/rls/registry.ts (a table missing from that registry already fails the build).
--
-- ⚠️ FORCE is not optional. Without it the table OWNER bypasses its own policy, so every test
-- run as the owner would pass while a real tenant connection sees something different.
-- ---------------------------------------------------------------------------------------

-- sales_channels and sales_days carry org_id directly — org_column.
ALTER TABLE "sales_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sales_channels_org_isolation" ON "sales_channels" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "sales_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_days" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sales_days_org_isolation" ON "sales_days" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- sales_day_channels has no org_id of its own — derived through the sales day it belongs to,
-- the same pattern as expense_payments through expenses.
ALTER TABLE "sales_day_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_day_channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sales_day_channels_via_sales_day" ON "sales_day_channels" FOR ALL
	USING (EXISTS (SELECT 1 FROM "sales_days" sd WHERE sd."id" = "sales_day_channels"."sales_day_id" AND sd."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "sales_days" sd WHERE sd."id" = "sales_day_channels"."sales_day_id" AND sd."org_id" = app_current_org()));

-- No GRANTs here, deliberately: migration 0011 ran ALTER DEFAULT PRIVILEGES IN SCHEMA public,
-- so tables created afterwards are granted to shareat_app automatically. Repeating them would
-- imply that mechanism is unreliable, and the next person would start adding them everywhere.
