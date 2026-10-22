-- 0212 - T-464: POS tablet pairing (pos_tablet_pairings), the per-Employee-ID PIN bucket, and the staff-code guarantees.
-- docs/tasks/464-pos-tablet-sign-in.md; hand-authored per ADR-012 s5. Journal head when written: 0211 (0212/0213 belong to T-398 S3/S4).
--
-- PRECHECK - run these two SELECTs on the target database BEFORE this migration. Both must return ZERO rows.
-- The migration runs the same two checks itself and FAILS LOUDLY (RAISE EXCEPTION) if either returns rows; it never rewrites a code.
--   -- 1. staff codes that are not SE- plus digits (the CHECK below would refuse them):
--   SELECT id, store_id, staff_code FROM employments WHERE staff_code !~ '^SE-[0-9]{3,}$';
--   -- 2. two employments at one store sharing a number (SE-007 and SE-0007 are the same number to the tablet):
--   SELECT store_id, ltrim(substring(staff_code from 4), '0') AS num, count(*), array_agg(staff_code)
--     FROM employments GROUP BY 1, 2 HAVING count(*) > 1;
--
-- WHY. (1) A POS tablet is paired once per store; after that staff sign in with Employee ID + PIN. The Employee ID is the badge
-- code employments.staff_code, typed as its NUMBER only (7 -> SE-007). So the code must always be SE- plus digits, issued by the
-- allocator (never typed by hand), and two codes at one store must never share a number. (2) 5 wrong PINs for one Employee ID
-- pause that ID for 5 minutes: the throttle and its attempt log gain a nullable staff_code key (normalised upper-case).
-- (3) pos_tablet_pairings holds the server-issued, revocable secret (sha256 of 32 random bytes) the paired tablet keeps in a cookie.
--
-- GRANTS. pos_tablet_pairings: SELECT, INSERT, UPDATE for shareat_app (a revoke / last_used_at is an UPDATE); no DELETE.
-- RLS. ENABLE + FORCE, one org-isolation policy through app_current_org() (DEF-077) with WITH CHECK (DEF-183).
-- The pairing lookup before sign-in runs on the auth door (authTransaction) and is the one lookup of row 382.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "employments" WHERE "staff_code" !~ '^SE-[0-9]{3,}$') THEN
		RAISE EXCEPTION '0212 PRECHECK failed: employments.staff_code holds values that are not SE- plus 3 or more digits. Run the PRECHECK 1 SELECT at the top of this file and repair them by hand first.';
	END IF;
	IF EXISTS (SELECT 1 FROM "employments" GROUP BY "store_id", ltrim(substring("staff_code" from 4), '0') HAVING count(*) > 1) THEN
		RAISE EXCEPTION '0212 PRECHECK failed: two employments at one store share a staff-code number. Run the PRECHECK 2 SELECT at the top of this file and repair them by hand first.';
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_staff_code_shape_check" CHECK ("staff_code" ~ '^SE-[0-9]{3,}$');
--> statement-breakpoint
CREATE UNIQUE INDEX "employments_store_staff_number_unique" ON "employments" ("store_id", ltrim(substring("staff_code" from 4), '0'));
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD COLUMN "staff_code" text;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD COLUMN "staff_code" text;
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_staff_code_needs_store_check" CHECK ("staff_code" IS NULL OR "store_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_staff_code_needs_store_check" CHECK ("staff_code" IS NULL OR "store_id" IS NOT NULL);
--> statement-breakpoint
DROP INDEX "pin_attempt_throttle_store_id_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "pin_attempt_throttle_store_id_unique" ON "pin_attempt_throttle" ("store_id") WHERE "staff_code" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "pin_attempt_throttle_staff_code_unique" ON "pin_attempt_throttle" ("store_id", "staff_code") WHERE "staff_code" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "sign_in_attempts_staff_code_time_idx" ON "sign_in_attempts" ("store_id", "staff_code", "occurred_at") WHERE "staff_code" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "pos_tablet_pairings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"label" text NOT NULL,
	"cookie_digest" text NOT NULL,
	"paired_by" uuid NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "pos_tablet_pairings_label_check" CHECK (length(btrim("label")) > 0),
	CONSTRAINT "pos_tablet_pairings_revoked_shape_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "pos_tablet_pairings" ADD CONSTRAINT "pos_tablet_pairings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_tablet_pairings" ADD CONSTRAINT "pos_tablet_pairings_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_tablet_pairings" ADD CONSTRAINT "pos_tablet_pairings_paired_by_same_org_fk" FOREIGN KEY ("org_id", "paired_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_tablet_pairings" ADD CONSTRAINT "pos_tablet_pairings_revoked_by_same_org_fk" FOREIGN KEY ("org_id", "revoked_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_tablet_pairings_cookie_digest_unique" ON "pos_tablet_pairings" ("cookie_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_tablet_pairings_live_store_unique" ON "pos_tablet_pairings" ("store_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "pos_tablet_pairings_org_store_idx" ON "pos_tablet_pairings" ("org_id", "store_id");
--> statement-breakpoint
ALTER TABLE "pos_tablet_pairings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_tablet_pairings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_tablet_pairings_org_isolation" ON "pos_tablet_pairings"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_tablet_pairings" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pos_tablet_pairings" TO "shareat_app";
