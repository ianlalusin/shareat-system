-- 0052 — T-149 continued: sellability is per STORE, with the org-level flags as the default.
--
-- HAND-WRITTEN, like 0020-0051. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY. Ian, 2026-08-28: *"it must be store scoped coz the main branch shareat lipa might be
-- making the bulgogi sauce but the franchisee is purchasing it from shareat lipa."*
--
-- Bulgogi sauce is ONE item — one identity, one price history, org-wide (T-145, and the whole
-- reason v1's per-store items were rejected). What differs by store is what that store DOES with
-- it: Lipa makes it and sells it wholesale; another branch buys it in.
--
-- ⛔ THE TRAP THIS AVOIDS. The obvious move is a row per store per item — and that is exactly
-- v1's mistake, which produced 842 records for 385 real products and made price history
-- impossible. So identity stays org-level and only the EXCEPTION is stored:
--
--     items.is_purchasable / sellable_retail / sellable_wholesale   ← the org's default answer
--     store_item_sellability                                        ← where one store differs
--
-- With 385 items and 6 stores, a mandatory per-store row would be 2,310 rows of configuration
-- before anything worked. An override table is empty until somebody has a reason to fill it, and
-- a resolved answer is `coalesce(override, default)`.
--
-- ⚠️ NOT a per-store item master. This table holds three booleans and nothing else — no name, no
-- unit, no cost. The moment it grows a name or a unit it has become v1's items table again.

CREATE TABLE "store_item_sellability" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	-- ⚠️ NULLABLE on purpose: null means "no opinion, use the org default". A store overriding
	-- only `is_purchasable` should not be forced to restate the other two, because restating them
	-- freezes today's default into a copy that stops tracking it.
	"is_purchasable" boolean,
	"sellable_retail" boolean,
	"sellable_wholesale" boolean,
	"note" text,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	-- A row that overrides nothing is noise that looks like a decision.
	CONSTRAINT "store_item_sellability_not_empty_check" CHECK (
		"is_purchasable" is not null or "sellable_retail" is not null or "sellable_wholesale" is not null
	)
);
--> statement-breakpoint

ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_store_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_item_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_set_by_fk"
	FOREIGN KEY ("set_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "store_item_sellability_store_item_key" ON "store_item_sellability" USING btree ("store_id","item_id");--> statement-breakpoint
CREATE INDEX "store_item_sellability_org_item_idx" ON "store_item_sellability" USING btree ("org_id","item_id");--> statement-breakpoint

ALTER TABLE "store_item_sellability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_item_sellability" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "store_item_sellability_org_isolation" ON "store_item_sellability"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
