-- 0217 - T-475 S3: an admin may verify the supplier invoice they logged themselves (flagged, audited, role only).
-- docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md section 5.3 + amendments R1-R3, R7 + "Ian's answers (2026-10-24)" Q2=B, Q3=A, Q4=A.
-- Hand-authored per ADR-012 s5. Journal head when written: 0215 (0216 is POS T-472, merging first; the journal merge is the orchestrator's).
--
-- WHY. Segregation of duties (0046) made "the person who logged an invoice cannot verify it" a database rule. Ian ruled (24 Oct) that an admin or
-- super admin MAY verify their own invoice, as an audited exception: the row says so (self_verified), the domain writes a second audit row, and the
-- /ap list can show them. The capability (verify_own_supplier_invoice) is held by ROLE only (Q3=A): no person grant confers it, so the trigger below
-- has NO grant-lookup branch and accepts only an ACTIVE admin / super_admin role in the invoice's org.
--
-- WHAT THE DATABASE ENFORCES.
--   * supplier_invoices.self_verified boolean NOT NULL DEFAULT false (every existing row is false; historic rows are NOT back-flagged).
--   * supplier_invoices_two_person_verification_check keeps its name and now reads: verified_by IS NULL OR verified_by <> created_by OR self_verified
--     (stays NOT VALID, like 0046: history).
--   * supplier_invoices_self_verified_means_self_check: NOT self_verified OR verified_by = created_by (NOT VALID, then VALIDATEd: nothing is flagged yet).
--   * Trigger supplier_invoices_self_verify_requires_capability (BEFORE INSERT OR UPDATE, SECURITY INVOKER, validator / origin). It judges only a
--     write that CREATES or CHANGES a flagged pair: an INSERT with the flag, an UPDATE that sets the flag, or an UPDATE of a flagged row that changes
--     verified_by or created_by (R2). The person in NEW.verified_by must hold an ACTIVE role (revoked_at IS NULL) in NEW.org_id, and that role must be
--     admin or super_admin (R1); else 23514 naming the trigger. Any other UPDATE (void, payment status, notes) is NOT re-judged, so a later demotion
--     never blocks voiding. Limit, stated: the database knows the named verifier, not the session actor; that the verifier IS the actor stays the
--     domain's job, as for every verified_by column.
--   * Trigger supplier_invoices_self_verified_immutable (BEFORE UPDATE, history_guard / ENABLE ALWAYS, the 0168 pattern, R3): the flag is history and
--     can never go from true to false, even under session_replication_role = replica. Decides from OLD/NEW only.
--   * Partial index supplier_invoices_self_verified_idx ON (org_id, verified_at) WHERE self_verified, for the /ap "verified by its own creator" list.
--
-- LOCK BUDGET (ADR-012 s5).
--   * First statement: SET LOCAL lock_timeout = '5s'; last statement: RESET lock_timeout. A deploy that hits the timeout is re-run, never edited.
--   * Lock modes on supplier_invoices (all held to COMMIT, drizzle applies pending migrations in one transaction): ADD COLUMN with a constant default is
--     metadata-only but takes ACCESS EXCLUSIVE briefly; DROP / ADD CONSTRAINT ... NOT VALID take ACCESS EXCLUSIVE with no scan; VALIDATE CONSTRAINT takes
--     SHARE UPDATE EXCLUSIVE and scans the table once; CREATE TRIGGER takes SHARE ROW EXCLUSIVE; CREATE INDEX blocks writes while it builds. The table is
--     small (single-thousands of rows). Deploy outside store hours.
--   * Budget: re-timed on a local PG 18 scratch database at the full 0215 schema (see the T-475 S3 report); the ceiling is 60 s (D8).
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "self_verified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" DROP CONSTRAINT IF EXISTS "supplier_invoices_two_person_verification_check";
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_two_person_verification_check"
	CHECK ("verified_by" IS NULL OR "verified_by" <> "created_by" OR "self_verified") NOT VALID;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_self_verified_means_self_check"
	CHECK (NOT "self_verified" OR "verified_by" = "created_by") NOT VALID;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" VALIDATE CONSTRAINT "supplier_invoices_self_verified_means_self_check";
--> statement-breakpoint
CREATE INDEX "supplier_invoices_self_verified_idx" ON "supplier_invoices" ("org_id", "verified_at") WHERE "self_verified";
--> statement-breakpoint
CREATE FUNCTION supplier_invoices_self_verify_requires_capability() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	judge boolean := false;
	holder_role text;
BEGIN
	IF NEW.self_verified THEN
		IF TG_OP = 'INSERT' THEN
			judge := true;
		ELSIF NOT OLD.self_verified THEN
			judge := true;
		ELSIF NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
			judge := true; -- R2: a flagged pair is re-judged when either side of it moves
		END IF;
	END IF;
	IF NOT judge THEN
		RETURN NEW;
	END IF;
	-- R1: the verifier needs an ACTIVE role row in this invoice's org (no role = refused, as authorize() refuses); Q3=A: admin / super_admin only, no grant branch.
	SELECT r.role INTO holder_role FROM person_roles r
	 WHERE r.person_id = NEW.verified_by AND r.org_id = NEW.org_id AND r.revoked_at IS NULL
	 LIMIT 1;
	IF holder_role IS NULL OR holder_role NOT IN ('admin', 'super_admin') THEN
		RAISE EXCEPTION 'supplier_invoices_self_verify_requires_capability: only an admin or super admin may verify a supplier invoice they logged themselves'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_self_verify_requires_capability';
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION supplier_invoices_self_verified_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF OLD.self_verified AND NOT NEW.self_verified THEN
		RAISE EXCEPTION 'supplier_invoices_self_verified_immutable: the self-verified flag is history and cannot be cleared'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_self_verified_immutable';
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION supplier_invoices_self_verify_requires_capability() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION supplier_invoices_self_verified_immutable() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "supplier_invoices_self_verify_requires_capability" BEFORE INSERT OR UPDATE ON "supplier_invoices" FOR EACH ROW EXECUTE FUNCTION supplier_invoices_self_verify_requires_capability();
--> statement-breakpoint
CREATE TRIGGER "supplier_invoices_self_verified_immutable" BEFORE UPDATE ON "supplier_invoices" FOR EACH ROW EXECUTE FUNCTION supplier_invoices_self_verified_immutable();
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ENABLE ALWAYS TRIGGER "supplier_invoices_self_verified_immutable";
--> statement-breakpoint
RESET lock_timeout;
