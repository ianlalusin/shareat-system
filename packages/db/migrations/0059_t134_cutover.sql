-- 0059 — T-134: the 31 December conversion. A guided, verified switch.
--
-- HAND-WRITTEN, like 0020-0058. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ It is a CONVERSION, not an onboarding wizard, and it runs TWICE: a November rehearsal against
-- a restored database, then the real thing. ⛔ There is no `REHEARSAL` flag anywhere — ADR-007
-- already provides the isolation, and *a flag is a marker a code path can forget to set*, which
-- would produce a rehearsal attestation indistinguishable from a real one. **The restored database
-- cannot forget what it is.**

-- ---------------------------------------------------------------------------------------------
-- 1. Where the wizard remembers itself.
--
-- ⚠️ Resumable across WEEKS, and that needs no engineering: one row per (step, store) carrying who,
-- when, and how it completed. Four stores means four rows, not a framework.
CREATE TABLE "cutover_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- Null for an org-wide step. A per-store step gets one row PER STORE, deliberately: a single
	-- tick across four stores hides the store nobody visited.
	"store_id" uuid,
	"step_code" text NOT NULL,
	-- ⭐ How it completed, and the three are NOT interchangeable on screen:
	--   verified  a query proved it, and it CANNOT be ticked by hand
	--   attested  a named person stated it - visibly weaker, and it says so
	--   performed the wizard ran it and recorded the result
	"completion" text NOT NULL,
	"note" text,
	"completed_by" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cutover_steps_completion_check" CHECK ("completion" in ('verified','attested','performed'))
);--> statement-breakpoint

ALTER TABLE "cutover_steps" ADD CONSTRAINT "cutover_steps_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "cutover_steps" ADD CONSTRAINT "cutover_steps_store_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "cutover_steps" ADD CONSTRAINT "cutover_steps_by_fk"
	FOREIGN KEY ("completed_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

-- One completion per step per store. Re-attesting replaces, and the ON CONFLICT target needs this.
-- ⚠️ `coalesce` on the nullable store, because NULL never equals NULL in a unique index.
CREATE UNIQUE INDEX "cutover_steps_step_store_key"
	ON "cutover_steps" USING btree ("org_id","step_code",(coalesce("store_id", '00000000-0000-0000-0000-000000000000'::uuid)));--> statement-breakpoint

ALTER TABLE "cutover_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cutover_steps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cutover_steps_org_isolation" ON "cutover_steps"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The counted stock — step B3, and the input to C3's inventory opening balances.
--
-- ⭐ **An item silently absent is indistinguishable from an item counted as zero**, so a zero must
-- be entered explicitly and the check asks for a row per active item rather than a non-zero total.
--
-- ⚠️ Counted BEFORE it can be priced, deliberately. ADR-009: the cost basis is weakest for exactly
-- the stock being valued, which is why A1 (clear the delivery-expensing backlog) is a HARD gate in
-- front of B1 — counting first prices the newest, and only, stock at nothing. That inversion took
-- counting to find; nobody would have reasoned their way to it.
CREATE TABLE "opening_counts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	-- Zero is a real, meaningful answer and must be storable.
	"quantity" numeric(14, 3) NOT NULL,
	-- Null until the count is valued. C3 lists these as gaps by name.
	"unit_cost" numeric(14, 4),
	"note" text,
	"counted_by" uuid NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_counts_quantity_non_negative_check" CHECK ("quantity" >= 0),
	CONSTRAINT "opening_counts_unit_cost_non_negative_check" CHECK ("unit_cost" is null or "unit_cost" >= 0)
);--> statement-breakpoint

ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_store_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_item_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_by_fk"
	FOREIGN KEY ("counted_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "opening_counts_store_item_key" ON "opening_counts" USING btree ("store_id","item_id");--> statement-breakpoint
CREATE INDEX "opening_counts_org_idx" ON "opening_counts" USING btree ("org_id");--> statement-breakpoint

ALTER TABLE "opening_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opening_counts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "opening_counts_org_isolation" ON "opening_counts"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
