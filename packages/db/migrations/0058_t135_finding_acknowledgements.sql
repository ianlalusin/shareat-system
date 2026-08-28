-- 0058 — T-135: integrity findings. The books watchdog.
--
-- HAND-WRITTEN, like 0020-0057. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ THE WHOLE DESIGN IS THE TABLE THAT IS *NOT* HERE. There is no `findings` table.
--
-- v1 stores a finding's `state` per key, and that is its one real defect (task spec §"The one
-- gap"): a manager resolves *"expense missing category"*, tomorrow's recompute produces the same
-- key, reads the stored `resolved`, and suppresses it — while the expense still has no category.
-- **Resolution suppresses the SYMPTOM without requiring the CAUSE to be fixed**, and the longer it
-- stays resolved the more confident the suppression looks.
--
-- ⭐ So the FINDING is derived on every read and only the ACKNOWLEDGEMENT is stored:
--
--   condition holds + not acknowledged  -> OPEN
--   condition holds + acknowledged      -> ACKNOWLEDGED: off the attention list, STILL COUNTED,
--                                          and the acknowledgement visibly ages
--   condition gone                      -> the finding is GONE, and the acknowledgement is history
--
-- ⛔ **A finding cannot be "resolved" while it is still true.** The only way to clear it is to fix
-- the thing. Acknowledgement says *"I have seen this and accept it for now"* — a real statement,
-- and a different one from *"this is fixed."*
--
-- ⚠️ This is also what makes the manager scorecard safe to keep: a score people are measured on is
-- a score people manage, and the derived model makes the obvious gaming — clearing findings without
-- fixing causes — impossible rather than merely discouraged.

CREATE TABLE "finding_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- Null for an ORG-wide finding (a trial balance does not belong to one store).
	"store_id" uuid,
	-- The finding's stable identity: kind + whatever the kind is about. Derived by the detector,
	-- never chosen by a person.
	"finding_key" text NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"acknowledged_by" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- ⭐ An accepted risk should be RE-accepted, not forgotten. After this the finding reopens on
	-- its own, with no action from anybody.
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_acknowledgements_window_check" CHECK ("expires_at" > "acknowledged_at")
);--> statement-breakpoint

ALTER TABLE "finding_acknowledgements" ADD CONSTRAINT "finding_acknowledgements_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "finding_acknowledgements" ADD CONSTRAINT "finding_acknowledgements_store_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "finding_acknowledgements" ADD CONSTRAINT "finding_acknowledgements_by_fk"
	FOREIGN KEY ("acknowledged_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

-- ⚠️ NOT a unique index. Expired acknowledgements are KEPT — who accepted what, and when, is the
-- accountability record — so a finding legitimately has many rows over time and the LATEST live one
-- wins. ⛔ A partial unique index on `expires_at > now()` is not possible: an index predicate must
-- be IMMUTABLE and `now()` is only STABLE. The "one live acknowledgement" rule is a query
-- (`order by acknowledged_at desc limit 1`), which is also the honest shape: it is a fact about a
-- moment, not about a row.
CREATE INDEX "finding_acknowledgements_key_idx"
	ON "finding_acknowledgements" USING btree ("org_id","finding_key","acknowledged_at" DESC);--> statement-breakpoint
CREATE INDEX "finding_acknowledgements_org_kind_idx" ON "finding_acknowledgements" USING btree ("org_id","kind");--> statement-breakpoint

ALTER TABLE "finding_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_acknowledgements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "finding_acknowledgements_org_isolation" ON "finding_acknowledgements"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
