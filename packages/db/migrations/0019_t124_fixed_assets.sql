CREATE TABLE "asset_category_lives" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"category" text NOT NULL,
	"useful_life_years" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "asset_category_lives_positive_check" CHECK ("asset_category_lives"."useful_life_years" > 0)
);
--> statement-breakpoint
CREATE TABLE "asset_policy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"capitalization_threshold" numeric(14, 2) NOT NULL,
	"default_salvage_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "asset_policy_threshold_positive_check" CHECK ("asset_policy"."capitalization_threshold" > 0),
	CONSTRAINT "asset_policy_salvage_non_negative_check" CHECK ("asset_policy"."default_salvage_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"acquired_on" date,
	"cost" numeric(14, 2),
	"salvage_value" numeric(14, 2) DEFAULT '0',
	"useful_life_years" integer NOT NULL,
	"method" text DEFAULT 'straight_line' NOT NULL,
	"interval" text DEFAULT 'monthly' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"source_expense_id" uuid,
	"disposed_on" date,
	"disposal_reason" text,
	"disposed_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "fixed_assets_cost_positive_check" CHECK ("fixed_assets"."cost" is null or "fixed_assets"."cost" > 0),
	CONSTRAINT "fixed_assets_salvage_non_negative_check" CHECK ("fixed_assets"."salvage_value" is null or "fixed_assets"."salvage_value" >= 0),
	CONSTRAINT "fixed_assets_salvage_below_cost_check" CHECK ("fixed_assets"."salvage_value" is null or "fixed_assets"."cost" is null or "fixed_assets"."salvage_value" < "fixed_assets"."cost"),
	CONSTRAINT "fixed_assets_useful_life_positive_check" CHECK ("fixed_assets"."useful_life_years" > 0),
	CONSTRAINT "fixed_assets_status_check" CHECK ("fixed_assets"."status" in ('active', 'disposed', 'pending_valuation')),
	CONSTRAINT "fixed_assets_valuation_shape_check" CHECK (
        ("fixed_assets"."status" = 'pending_valuation' and "fixed_assets"."cost" is null and "fixed_assets"."acquired_on" is null)
        or ("fixed_assets"."status" <> 'pending_valuation' and "fixed_assets"."cost" is not null and "fixed_assets"."acquired_on" is not null)
      ),
	CONSTRAINT "fixed_assets_disposal_pair_check" CHECK (
        ("fixed_assets"."status" = 'active' and "fixed_assets"."disposed_on" is null and "fixed_assets"."disposal_reason" is null)
        or ("fixed_assets"."status" = 'disposed' and "fixed_assets"."disposed_on" is not null and "fixed_assets"."disposal_reason" is not null)
      ),
	CONSTRAINT "fixed_assets_disposal_after_acquisition_check" CHECK ("fixed_assets"."disposed_on" is null or "fixed_assets"."disposed_on" >= "fixed_assets"."acquired_on")
);
--> statement-breakpoint
ALTER TABLE "asset_category_lives" ADD CONSTRAINT "asset_category_lives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_policy" ADD CONSTRAINT "asset_policy_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_source_expense_id_expenses_id_fk" FOREIGN KEY ("source_expense_id") REFERENCES "public"."expenses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposed_by_persons_id_fk" FOREIGN KEY ("disposed_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_category_lives_org_id_category_unique" ON "asset_category_lives" USING btree ("org_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_policy_org_id_unique" ON "asset_policy" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_id_store_id_idx" ON "fixed_assets" USING btree ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_id_status_idx" ON "fixed_assets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "fixed_assets_category_idx" ON "fixed_assets" USING btree ("category");--> statement-breakpoint
CREATE INDEX "fixed_assets_needs_review_idx" ON "fixed_assets" USING btree ("needs_review");--> statement-breakpoint
CREATE INDEX "fixed_assets_source_expense_id_idx" ON "fixed_assets" USING btree ("source_expense_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Row Level Security — hand-written; drizzle-kit does not generate policies.
-- All three carry org_id directly. FORCE as always: without it the owner bypasses its own
-- policy, so tests run as the owner would pass while a real tenant saw something else.
--
-- ⚠️ Worth stating why the boundary matters here beyond habit: an asset register lists what a
-- business OWNS, so cross-org visibility would hand a franchisee an inventory of another
-- franchisee's equipment and what it cost them.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "asset_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "asset_policy_org_isolation" ON "asset_policy" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "asset_category_lives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_category_lives" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "asset_category_lives_org_isolation" ON "asset_category_lives" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "fixed_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fixed_assets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fixed_assets_org_isolation" ON "fixed_assets" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

-- No GRANTs: migration 0011's ALTER DEFAULT PRIVILEGES covers tables created afterwards.
