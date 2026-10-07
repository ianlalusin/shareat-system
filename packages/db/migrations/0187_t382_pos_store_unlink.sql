-- 0187 - T-382, docs/tasks/382-pos-store-unlink.md: a guarded POS unlink, soft, on the link row.
--
-- PURPOSE: Ian 2026-10-07 (Open Questions t375-unlink-safety, a): a super-admin can unlink a store from POS, with a
-- reason, audited; days already imported stay exactly as they are. The unlink is NOT a delete: three columns on the
-- link row (unlinked_at / unlinked_by / unlink_reason, all NULL on a live link), and relink stays an UPDATE of the same row.
--
-- THE MEANING OF "LINKED" CHANGES. 0185's header and packages/db/schema/pos-v1.ts say a store is linked when it has a
-- row in pos_v1_store_links. From 0187 a store is linked when it has a LIVE row (unlinked_at IS NULL). 0185 is applied
-- and is never edited; this header restates the meaning. The one database reader, sales_day_store_is_linked, changes by
-- one predicate; its shape is kept EXACTLY (REV-5): the two-argument signature (CREATE OR REPLACE, so no overload),
-- LANGUAGE plpgsql, SECURITY INVOKER (no SECURITY DEFINER on any of the three functions), and 0185's fail-closed
-- app_current_org() block verbatim.
--
-- R4 HARDENS 0185: no imported figure can change on an unlinked store, even under the derivation flag. The feed-day UPDATE
-- branch of sales_days_check_figure_lock and the feed-day remitted/tender branch of sales_day_child_row_allowed gain
-- "and the store is linked". Platform (non-remitted) rows are untouched. Bodies are 0185's, verbatim, except those lines.
--
-- R10: two CHECKs (shape, reason length) and an FK unlinked_by -> persons ON DELETE restrict.
--
-- GRANTS unchanged: shareat_app keeps SELECT, INSERT, UPDATE on pos_v1_store_links, no DELETE. No new table, trigger or
-- index (REV-1: 0183's full UNIQUE on pos_store_id stays, so a POS id stays held by its store while it is unlinked).
-- No RLS registry / classification / trigger-registry change.
--
-- R6a BACKFILL (between the B0187 markers): the new capability unlink_store_from_pos is super-admin-only, and
-- holdsSuperAdminAuthority (packages/auth/src/roles.ts) needs ALL super-admin-only grants, so each existing owner gets
-- the new one: every person with an ACTIVE admin role and live grants of all four current ones. person_grants is FORCE
-- ROW LEVEL SECURITY (0014:84), so the block runs with row_security off (the 0166 pattern): only a role RLS cannot filter
-- (doadmin in production) can apply it; any other role fails LOUDLY (SQLSTATE 42501) instead of granting nobody.
--
-- PRECHECKS (read-only, run as doadmin with Ian before the push; docs/ops/README.md deploy-gate table):
--   P0187a  SELECT count(*) FROM pos_v1_store_links;   -- informational: 0 before Monday 12 Oct, 1 after
--   P0187b  SELECT p.display_name, r.role, count(DISTINCT g.grant_name) AS grants
--             FROM person_grants g JOIN persons p ON p.id = g.person_id
--             LEFT JOIN person_roles r ON r.person_id = g.person_id AND r.revoked_at IS NULL
--            WHERE g.revoked_at IS NULL AND g.grant_name IN ('approve_item','post_journal_entry','cross_org_access','view_franchise_sales')
--            GROUP BY 1, 2 ORDER BY 1;   -- the backfill grants exactly role = 'admin' AND grants = 4: Ian confirms only him
--   P0187c  SELECT count(*) FROM person_roles WHERE role = 'super_admin' AND revoked_at IS NULL;  -- informational
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "pos_v1_store_links" ADD COLUMN "unlinked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD COLUMN "unlinked_by" uuid;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD COLUMN "unlink_reason" text;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_unlinked_by_persons_id_fk" FOREIGN KEY ("unlinked_by") REFERENCES "persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_unlink_shape_check" CHECK (("unlinked_at" IS NULL) = ("unlinked_by" IS NULL) AND ("unlinked_at" IS NULL) = ("unlink_reason" IS NULL));
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_unlink_reason_check" CHECK ("unlink_reason" IS NULL OR (btrim("unlink_reason") <> '' AND char_length("unlink_reason") <= 500));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_day_store_is_linked"(p_store_id uuid, p_constraint text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
	bypass boolean;
BEGIN
	IF app_current_org() IS NULL THEN
		SELECT coalesce(rolsuper OR rolbypassrls, false) INTO bypass FROM pg_roles WHERE rolname = current_user;
		IF NOT coalesce(bypass, false) THEN
			RAISE EXCEPTION 'Sales figures cannot be written without an organisation context (T-375, R6).'
				USING ERRCODE = '23514', CONSTRAINT = p_constraint;
		END IF;
	END IF;
	RETURN EXISTS (SELECT 1 FROM "pos_v1_store_links" WHERE store_id = p_store_id AND unlinked_at IS NULL);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_days_check_figure_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	flag_on boolean := coalesce(nullif(current_setting('app.sales_day_derivation', true), ''), 'off') = 'on';
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF "sales_day_store_is_linked"(NEW.store_id, 'sales_days_figures_locked') THEN
			IF NOT flag_on OR NEW.source <> 'pos_v1_day_feed' THEN
				RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a day is created only by the import.'
					USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
			END IF;
		ELSIF NEW.source = 'pos_v1_day_feed' THEN
			RAISE EXCEPTION 'A feed-sourced sales day needs its store linked to POS (T-375, R6).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
		END IF;
		RETURN NEW;
	END IF;

	-- UPDATE: only a change to a protected column is judged; status, sign-off and journal columns stay writable.
	IF NEW.store_id IS NOT DISTINCT FROM OLD.store_id
		AND NEW.business_date IS NOT DISTINCT FROM OLD.business_date
		AND NEW.source IS NOT DISTINCT FROM OLD.source
		AND NEW.pos_v1_day_feed_id IS NOT DISTINCT FROM OLD.pos_v1_day_feed_id
		AND NEW.pos_sourced IS NOT DISTINCT FROM OLD.pos_sourced
		AND NEW.pos_sourced_at IS NOT DISTINCT FROM OLD.pos_sourced_at
		AND NEW.total_sales IS NOT DISTINCT FROM OLD.total_sales
		AND NEW.unli_sales IS NOT DISTINCT FROM OLD.unli_sales
		AND NEW.ala_carte_sales IS NOT DISTINCT FROM OLD.ala_carte_sales
		AND NEW.senior_discount IS NOT DISTINCT FROM OLD.senior_discount
		AND NEW.pwd_discount IS NOT DISTINCT FROM OLD.pwd_discount
		AND NEW.other_discount IS NOT DISTINCT FROM OLD.other_discount
		AND NEW.comps IS NOT DISTINCT FROM OLD.comps
		AND NEW.service_charge IS NOT DISTINCT FROM OLD.service_charge
		AND NEW.other_charges IS NOT DISTINCT FROM OLD.other_charges
		AND NEW.cash_collected IS NOT DISTINCT FROM OLD.cash_collected
		AND NEW.online_collected IS NOT DISTINCT FROM OLD.online_collected
		AND NEW.credit_sales IS NOT DISTINCT FROM OLD.credit_sales
		AND NEW.refunds IS NOT DISTINCT FROM OLD.refunds
	THEN
		RETURN NEW;
	END IF;

	IF NEW.source IS DISTINCT FROM OLD.source THEN
		RAISE EXCEPTION 'The source of a sales day never changes (T-375, R6).'
			USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
	END IF;

	IF OLD.source = 'pos_v1_day_feed' THEN
		IF NOT flag_on OR OLD.status NOT IN ('open', 'submitted') OR NOT "sales_day_store_is_linked"(OLD.store_id, 'sales_days_figures_locked') THEN
			RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a feed day changes only inside the derivation, while open or submitted and its store is linked (T-382, R4).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
		END IF;
	ELSIF "sales_day_store_is_linked"(OLD.store_id, 'sales_days_figures_locked')
		OR "sales_day_store_is_linked"(NEW.store_id, 'sales_days_figures_locked') THEN
		RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a typed day is writable only while its store is not linked.'
			USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales_day_child_row_allowed"(p_day_id uuid, p_remitted boolean, p_constraint text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
	d_source text;
	d_status text;
	d_store uuid;
	flag_on boolean := coalesce(nullif(current_setting('app.sales_day_derivation', true), ''), 'off') = 'on';
BEGIN
	SELECT source, status, store_id INTO d_source, d_status, d_store FROM "sales_days" WHERE id = p_day_id;
	IF NOT FOUND THEN
		RETURN true; -- not visible or not there: the foreign key / RLS decides
	END IF;
	IF d_source = 'pos_v1_day_feed' THEN
		IF p_remitted IS NOT DISTINCT FROM false THEN
			RETURN d_status IN ('open', 'submitted'); -- a platform row (R8): typed, but only before the day is verified
		END IF;
		-- R4 (T-382): remitted and tender rows also need the store LINKED. An unlinked store's imported days never change.
		RETURN flag_on AND d_status IN ('open', 'submitted') AND "sales_day_store_is_linked"(d_store, p_constraint);
	END IF;
	RETURN NOT "sales_day_store_is_linked"(d_store, p_constraint);
END;
$$;
--> statement-breakpoint
-- B0187:begin
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source")
SELECT g."person_id", 'unlink_store_from_pos', NULL, 'owner'
  FROM "person_grants" g
 WHERE g."revoked_at" IS NULL
   AND g."grant_name" IN ('approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales')
   AND EXISTS (SELECT 1 FROM "person_roles" r
                WHERE r."person_id" = g."person_id" AND r."role" = 'admin' AND r."revoked_at" IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "person_grants" u
                    WHERE u."person_id" = g."person_id" AND u."grant_name" = 'unlink_store_from_pos'
                      AND u."revoked_at" IS NULL AND u."store_id" IS NULL)
 GROUP BY g."person_id"
HAVING count(DISTINCT g."grant_name") = 4;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0187:end
