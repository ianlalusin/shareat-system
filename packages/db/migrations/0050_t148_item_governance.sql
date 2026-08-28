-- 0050 — T-148: item governance. Requests, approval, near-duplicate detection, and merge.
-- docs/tasks/148-item-governance.md.
--
-- HAND-WRITTEN, like 0020-0049. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY. Ian, 2026-08-28: *"design it so it is nearly impossible to duplicate an item."* The
-- import already proved the risk is real rather than theoretical — v1's 385 names contain
-- `Bean sprout` (kg) and `Beans Sprout` (pcs), the same product measured two ways, and my own
-- first import created `3D W/LID` alongside `3D W/LID.` before the check existed.
--
-- Three mechanisms, weakest to strongest:
--   1. `unique (org_id, lower(name))` — already there since T-145. Catches EXACT collisions only.
--   2. ⭐ TRIGRAM SIMILARITY — catches what case-folding cannot. Measured on the real names:
--        3D W/LID   vs 3D W/LID.     -> 1.00
--        Bean sprout vs Beans Sprout -> 0.79
--        Coke 1.5   vs Coke 15       -> 0.55
--        Pork Belly vs Beef Belly    -> 0.43   (correctly NOT a duplicate)
--      A 0.5 floor separates the real duplicates from unrelated items with room to spare.
--      ⚠️ It WARNS a human; it never blocks and never merges. `Coke 1.5`/`Coke 15` score 0.55 and
--      are genuinely different products — a machine cannot tell those from a typo.
--   3. **A second person.** Only a super-admin creates an item; everyone else asks. Fuzzy matching
--      degrades as the catalogue grows, but a human reviewing every addition does not.
--
-- ⛔ pg_trgm is a CONTRIB EXTENSION, not core. It ships with the standard PostgreSQL distribution
-- and with the postgres:18 Docker image this project uses, but a hardened managed instance can
-- have it unavailable. If this migration fails here, that is why — and the answer is to enable it
-- on the server, never to fall back to matching in TypeScript, which would move a set-based
-- similarity join into N round trips.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- ===========================================================================================
-- items: a merged item is neither active nor deleted.
--
-- ⭐ A merged item's row SURVIVES and keeps pointing at its winner. Deleting it would break every
-- invoice line, price-list rate and supplier link that referenced it — and would erase the fact
-- that the duplicate ever existed, which is exactly what someone investigating a price anomaly a
-- year later needs to see.
-- ===========================================================================================
ALTER TABLE "items" DROP CONSTRAINT "items_status_check";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_status_check" CHECK ("status" in ('active','inactive','merged'));--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_merged_into_id_items_id_fk"
	FOREIGN KEY ("merged_into_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint
-- Merged and only merged: the pointer and the status agree, or the row is refused.
ALTER TABLE "items" ADD CONSTRAINT "items_merged_shape_check"
	CHECK (("status" = 'merged') = ("merged_into_id" is not null));--> statement-breakpoint
-- ⛔ An item cannot merge into itself.
ALTER TABLE "items" ADD CONSTRAINT "items_merged_not_self_check"
	CHECK ("merged_into_id" is null or "merged_into_id" <> "id");--> statement-breakpoint

-- ⭐ The index that makes the similarity search a scan of neighbours rather than of everything.
CREATE INDEX "items_name_trgm_idx" ON "items" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint

-- ===========================================================================================
-- item_requests — everyone below super-admin asks; a super-admin decides.
--
-- Mirrors `cash_requests`'s shape (requested -> approved/rejected) because this project already
-- has one request-and-approve flow and a second one that behaved differently would be a second
-- thing to learn.
-- ===========================================================================================
CREATE TABLE "item_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"base_unit" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'requested' NOT NULL,
	-- ⭐ What the similarity check found AT REQUEST TIME, frozen. Recomputing it at approval would
	-- answer a different question — the catalogue moves — and the approver needs to see what the
	-- requester was shown.
	"similar_warning" text,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	-- Set when approval actually mints the item, so the request and its result are linked.
	"created_item_id" uuid,
	CONSTRAINT "item_requests_status_check" CHECK ("status" in ('requested','approved','rejected')),
	CONSTRAINT "item_requests_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "item_requests_kind_check" CHECK ("kind" in ('raw_material','supply','retail','meat_slab','meat_sliced')),
	CONSTRAINT "item_requests_base_unit_check" CHECK ("base_unit" in ('pcs','kg','g','ltr','ml','roll')),
	-- A decision is a three-part fact: who, when, and what happened.
	CONSTRAINT "item_requests_decision_shape_check" CHECK (
		("status" = 'requested') = ("decided_by" is null and "decided_at" is null)
	),
	-- ⛔ An approved request must have produced an item; a rejected one must not have.
	CONSTRAINT "item_requests_created_item_shape_check" CHECK (
		("status" = 'approved') = ("created_item_id" is not null)
	)
);
--> statement-breakpoint

ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_requested_by_persons_id_fk"
	FOREIGN KEY ("requested_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_decided_by_persons_id_fk"
	FOREIGN KEY ("decided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_created_item_id_items_id_fk"
	FOREIGN KEY ("created_item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "item_requests_org_status_idx" ON "item_requests" USING btree ("org_id","status");--> statement-breakpoint

ALTER TABLE "item_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "item_requests_org_isolation" ON "item_requests"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
