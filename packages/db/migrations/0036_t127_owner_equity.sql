-- 0036 — T-127: owners, and equity attributable to each of them.
--
-- HAND-WRITTEN, like 0020-0035. `db:generate` cannot be used here: the drizzle snapshot chain
-- stops at 0019 and diffing against it would propose re-creating seventeen migrations' worth of
-- schema. See DEF-073.
--
-- ⛔ THERE ARE NO BALANCE COLUMNS ON `owners`, AND THAT IS THE POINT.
-- v1 keeps three (types/index.ts:2958-2968): totalCapital, totalDrawings, and netEquity — the last
-- commented "// totalCapital - totalDrawings", a stored copy of a subtraction. A third copy lives in
-- EquityLedgerEntry.balanceBefore/balanceAfter. Same shape as v1's loans (bible row 158), found
-- independently. DEF-072. Here the position is summed from 3100 and 3200 by party.
--
-- ⚠️ DEF-071 is why the drawing-limit CHECK below is shaped the way it is: v1 accepts a 'monthly'
-- period, writes it, DISPLAYS it back to the owner as a live constraint, and never checks it —
-- equity.actions.ts:249 only ever tests `=== 'total'`. Half a rule is not a rule.

CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text,
	"ownership_percentage" numeric(6, 3),
	"drawing_limit" numeric(14, 2),
	"drawing_limit_period" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "owners_status_check" CHECK ("owners"."status" in ('active','inactive')),
	CONSTRAINT "owners_drawing_limit_period_check" CHECK (
		"owners"."drawing_limit_period" is null
		or "owners"."drawing_limit_period" in ('monthly','total')
	),
	-- ⛔ Both or neither. A limit with no period cannot be measured; a period with no limit measures
	-- nothing. DEF-071 is what the second half looks like in production.
	CONSTRAINT "owners_drawing_limit_shape_check" CHECK (
		("owners"."drawing_limit" is null and "owners"."drawing_limit_period" is null)
		or ("owners"."drawing_limit" is not null and "owners"."drawing_limit_period" is not null)
	),
	CONSTRAINT "owners_drawing_limit_positive_check" CHECK (
		"owners"."drawing_limit" is null or "owners"."drawing_limit" > 0
	),
	-- ⚠️ Range only. Deliberately NOT validated to sum to 100 across a store: a store mid-restructure
	-- legitimately sits at 90% or 110% for a while, and a constraint that blocks recording reality is
	-- worse than a figure that is only advisory. T-127 §6.
	CONSTRAINT "owners_ownership_percentage_range_check" CHECK (
		"owners"."ownership_percentage" is null
		or ("owners"."ownership_percentage" > 0 and "owners"."ownership_percentage" <= 100)
	)
);
--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_person_id_persons_id_fk"
	FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "owners_org_store_idx" ON "owners" USING btree ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "owners_person_idx" ON "owners" USING btree ("person_id");--> statement-breakpoint
-- ⚠️ Two rows for the same human in the same store would split their capital across two parties and
-- make every per-owner figure quietly wrong.
CREATE UNIQUE INDEX "owners_store_person_key" ON "owners" USING btree ("store_id","person_id");--> statement-breakpoint

-- RLS. `org_column` scope — one franchise reading another's ownership split learns its cap table.
ALTER TABLE "owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owners_org_isolation" ON "owners"
	USING ("org_id" = current_setting('app.org_id', true)::uuid)
	WITH CHECK ("org_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- ⭐ party_type gains 'owner' — the fourth control account to name its subledger on the line,
-- after the wallet (row 142), the loan (row 158) and the cash request (row 159).
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_party_type_check";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_type_check"
	CHECK (
		"journal_lines"."party_type" is null
		or "journal_lines"."party_type" in ('supplier', 'customer', 'employee', 'store', 'channel', 'money_account', 'loan', 'cash_request', 'owner')
	);--> statement-breakpoint

-- ⭐ 3100 and 3200 become party-requiring. v1 DOES carry the owner — as `employeeId` on the entry
-- (equity-movement.builder.ts:57), a field named for something an owner is not. Moving it to the
-- LINE as a proper party is what makes v1's three stored totals unnecessary rather than merely
-- redundant: every figure the owner document held becomes a GROUP BY.
--
-- ⚠️ Nothing to backfill: v2 has posted nothing to either account. 3200 has never been used at all,
-- in v1 or here — the seed marks it "🆕 — never used in v1".
UPDATE "accounts" SET "requires_party" = true WHERE "code" in ('3100', '3200');
