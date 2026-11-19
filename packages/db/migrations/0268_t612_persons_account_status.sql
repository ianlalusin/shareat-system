-- 0268 - T-612 (Ian, 19 Nov 2026; supersedes bible row 340 and T-609's "no separate suspend switch"): every person has an ACCOUNT STATUS.
-- docs/tasks/612-staff-account-status.md. pending (hired, waiting for a manager) / active / suspended (rights kept, paused) / ended (T-609 ended the last job).
-- The column default is 'active', so every row written by older code (and every legacy fixture) keeps working; the hire path
-- (`createPerson`) and re-hire (`createEmployment`) set 'pending' explicitly. `persons.is_active` stays, unread, and is dropped by a later clean-up task.
-- The clock terminals' roster mirror (0088 trigger, publisher) is NOT touched: attendance is a work record, so a pending or suspended person with an open employment stays on it.
-- Backfill: is_active true -> active, false -> suspended; a terminal is always active (the CHECK below). Nobody who works today is locked out on deploy.
ALTER TABLE "persons" ADD COLUMN "account_status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
UPDATE "persons" SET "account_status" = CASE WHEN "kind" = 'terminal' OR "is_active" THEN 'active' ELSE 'suspended' END;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_account_status_check" CHECK ("account_status" in ('pending', 'active', 'suspended', 'ended'));
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_terminal_always_active_check" CHECK ("kind" <> 'terminal' OR "account_status" = 'active');
--> statement-breakpoint
-- 0220's franchise_reader_check refused a person who is not "active" by reading is_active; the same gate now reads the account status (body otherwise
-- byte-for-byte 0220's; CREATE OR REPLACE keeps its owner and its REVOKEs). v_active_employments (0080/0147) still reads is_active ON PURPOSE: it answers
-- "who is on the roster / payroll" from the employment, and a pending or suspended employee is still on it.
CREATE OR REPLACE FUNCTION "franchise_reader_check"("p_franchisee_org" uuid) RETURNS "franchise_agreements"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_org uuid := app_current_org();
	v_person uuid;
	a "franchise_agreements"%ROWTYPE;
BEGIN
	IF v_org IS NULL THEN
		RAISE EXCEPTION 'Looking at a franchise needs a signed-in organisation.' USING ERRCODE = '42501';
	END IF;
	v_person := nullif(current_setting('app.person_id', true), '')::uuid;
	IF v_person IS NULL THEN
		RAISE EXCEPTION 'Looking at a franchise needs a signed-in person.' USING ERRCODE = '42501';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = v_person AND p."org_id" = v_org AND p."account_status" = 'active') THEN
		RAISE EXCEPTION 'The signed-in person is not an active person of this organisation.' USING ERRCODE = '42501';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "person_roles" r WHERE r."person_id" = v_person AND r."org_id" = v_org AND r."role" = 'super_admin' AND r."revoked_at" IS NULL)
		AND NOT EXISTS (SELECT 1 FROM "person_grants" g WHERE g."person_id" = v_person AND g."grant_name" = 'view_franchise_sales' AND g."revoked_at" IS NULL AND g."store_id" IS NULL) THEN
		RAISE EXCEPTION 'This person does not hold the right to view franchise sales and stock.' USING ERRCODE = '42501';
	END IF;
	-- A NULL franchisee asks only for the person check (the franchisee picker list).
	IF p_franchisee_org IS NULL THEN
		RETURN NULL;
	END IF;
	SELECT f.* INTO a FROM "franchise_agreements" f WHERE f."org_id" = p_franchisee_org AND f."franchisor_org_id" = v_org;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Your organisation has no franchise agreement with that organisation.' USING ERRCODE = '42501';
	END IF;
	IF a."ended_on" IS NOT NULL AND a."ended_on" <= (now() AT TIME ZONE 'Asia/Manila')::date THEN
		RAISE EXCEPTION 'The franchise agreement with that organisation ended on %.', a."ended_on" USING ERRCODE = '42501';
	END IF;
	RETURN a;
END;
$$;
