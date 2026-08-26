-- 0026 — T-125 (docs/tasks/125-prepaid-and-amortisation.md): prepaid items and the expense
-- category seam that creates them.
--
-- Hand-written for the RLS policy, as 0021 and 0023 were: drizzle-kit generates no policies, and
-- a registry entry without one is "a promise, not a control".
--
-- ## What a prepaid item is
--
-- An expense already paid for but not yet used up — a year of insurance, a mayor's permit, six
-- months of rent in advance. It sits at 1400 and is released into the P&L a month at a time.
-- One of ADR-005's five capabilities that cannot wait past January: v1 posts 38 amortisation
-- legs, and without this a prepayment either hits one month in full or never lands at all.
--
-- ## ⛔ Three columns v1 has that are deliberately NOT here
--
--   amortizedToDate      hand-incremented at every write site
--   remainingBookValue   ditto, and v1's own type admits both are kept in sync "by convention"
--   monthlyAmortization  computed once, ROUNDED, and stored — then used as the basis for every
--                        period, so the rounding compounds
--
-- v1 drifted so thoroughly on the first two that it ended up with TWO independent code paths
-- computing "total remaining prepaid" that never read from each other. Here every figure is
-- derived from the ledger, exactly as T-124 derives accumulated depreciation.
--
-- ## ⭐ And one v1 has that is not here either: `voided`
--
-- Voiding an item in v1 cascade-reverses EVERY posted leg including the original purchase, which
-- is why one bad month can only be fixed by re-creating the item and re-running every prior
-- period. v2 reverses a single period instead, so the all-or-nothing state has nothing to do.

--> statement-breakpoint
CREATE TABLE "prepaid_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	-- The CONTRACT's term, not an estimate — which is why there is no interval column. Charging a
	-- 12-month policy quarterly would recognise cost for months not yet covered.
	"coverage_start_date" date NOT NULL,
	"coverage_months" integer NOT NULL,
	"total_cost" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	-- The coverage term was GUESSED from the category default rather than read off the document.
	"needs_review" boolean DEFAULT false NOT NULL,
	"source_expense_id" uuid,
	"written_off_on" date,
	"write_off_reason" text,
	"written_off_by" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "prepaid_items_cost_positive_check" CHECK ("prepaid_items"."total_cost" > 0),
	CONSTRAINT "prepaid_items_coverage_months_check" CHECK ("prepaid_items"."coverage_months" >= 1 and "prepaid_items"."coverage_months" <= 120),
	CONSTRAINT "prepaid_items_status_check" CHECK ("prepaid_items"."status" in ('active', 'fully_amortised', 'written_off')),
	-- All-or-nothing, the same shape fixed_assets' disposal pair uses: a half-populated
	-- termination cannot exist, and 'written_off' cannot be quietly used as "active but somebody
	-- typed a date".
	CONSTRAINT "prepaid_items_write_off_shape_check" CHECK (("prepaid_items"."status" = 'written_off') = ("prepaid_items"."written_off_on" is not null and "prepaid_items"."write_off_reason" is not null)),
	CONSTRAINT "prepaid_items_write_off_after_start_check" CHECK ("prepaid_items"."written_off_on" is null or "prepaid_items"."written_off_on" >= "prepaid_items"."coverage_start_date"),
	CONSTRAINT "prepaid_items_name_not_blank_check" CHECK (length(trim("prepaid_items"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_source_expense_id_expenses_id_fk"
	FOREIGN KEY ("source_expense_id") REFERENCES "public"."expenses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_written_off_by_persons_id_fk"
	FOREIGN KEY ("written_off_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "prepaid_items_org_store_idx" ON "prepaid_items" ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "prepaid_items_org_status_idx" ON "prepaid_items" ("org_id","status");--> statement-breakpoint
CREATE INDEX "prepaid_items_needs_review_idx" ON "prepaid_items" ("needs_review");--> statement-breakpoint
CREATE INDEX "prepaid_items_source_expense_idx" ON "prepaid_items" ("source_expense_id");--> statement-breakpoint

ALTER TABLE "prepaid_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prepaid_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "prepaid_items_org_isolation" ON "prepaid_items"
	FOR ALL
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ── The seam (T-125 §11, Ian's option B) ────────────────────────────────────────────────
-- v2 had no way to say "spend in this category may be a prepayment". v1 does, on its 22 seeded
-- templates (`capitalizable` + `defaultCoverageMonths`), and its handoff still lost every value
-- the user typed — a button that navigated to an empty form. These two columns are that idea
-- rebuilt on the table v2 already has, so the item is created carrying amount, date, supplier and
-- the source expense id.
ALTER TABLE "expense_categories" ADD COLUMN "prepaid_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN "default_coverage_months" integer;
