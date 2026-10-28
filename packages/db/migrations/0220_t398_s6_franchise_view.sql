-- 0220 - T-398 S6 (S6b): the franchisor's view of Padre Garcia's sales and stock, the access log every look leaves, and break-glass logging.
-- docs/tasks/398-padre-garcia-franchise-org.md section 0b (Q1 a, Q2 b, Q10 a) + R6, A5, A10, B3, B9, B13, C4, C6; docs/tasks/398-s6/{S6-REFRESH,QUESTIONS,TESTS}.md (K1-K12, QO-1..QO-8).
-- Hand-authored per ADR-012 s5 (db:generate is retired, DEF-242). Journal head when written: 0219.
--
-- WHY. Ian's company (the franchisor) must see how Padre Garcia (PG, a SEPARATE organisation) sells per day and what it holds in stock, and nothing else of PG's:
-- no cost, price paid, supplier, wage, expense or bank account. Every look is written down BY THE DATABASE in a log PG's owner can read, so no screen and no
-- code path can read PG's figures without leaving a row. Ian's "full access" to PG is a separate person INSIDE PG with its own sign-in; every sign-in and every
-- PIN approval by that person lands in the same log. Money is numeric, never float.
--
-- WHAT THIS MIGRATION ADDS.
--   1. franchise_agreements (R6, A5): one row per franchisee (UNIQUE org_id): who its franchisor is, which PG person is the franchisor's own (UNIQUE franchisor_person_id,
--      composite to the franchisee's persons), and sales_visible_from (the first date the franchisor may see). The app role has SELECT only; the owner path (S7) writes it.
--   2. franchise_access_log (A5, B3, C4): append-only for EVERY role. One row per successful look (sales_daily / stock_levels) and one per break-glass use
--      (break_glass_sign_in / break_glass_approval). One CHECK per kind states exactly which columns are set. The two person columns are composite FKs to their OWN
--      organisation (K6): reader_person_id -> (franchisor_org_id, id), franchisee_person_id -> (org_id, id); CROSS_ORG_BY_DESIGN stays empty. session_id has NO foreign key
--      (K12): sessions is purged at cutover, a kept log row must not block that; it is declared a snapshot in the NO_FK census.
--   3. The SECURITY DEFINER set, pinned here (V14 reads this list). Four callable by the application role and two private:
--        franchise_sales_daily(p_franchisee_org, p_from, p_to, p_reason)   - one function, rows tagged row_kind day / channel (K2); gross composed exactly as routeInputForDay (K3);
--                                                                            refuses a range before sales_visible_from, to < from, or more than 366 days, in words, logging nothing (QO-6)
--        franchise_stock_levels(p_franchisee_org, p_store, p_reason)       - on hand per active item over all locations, the low-stock line, at-or-below flag (K9)
--        franchise_franchisees()                                           - the picker list (K11); person-checked, NOT logged (no business figure)
--        log_break_glass_approval(p_person, p_capability, p_store)         - called by the PIN-approval verifiers; adds a row ONLY for an agreement's franchisor person
--        franchise_reader_check(p_franchisee_org)                          - PRIVATE guard shared by the three readers; granted to nobody
--        sessions_break_glass_log()                                        - PRIVATE trigger function of sessions_break_glass_log_trg
--      Each is SET search_path = public, pg_temp and REVOKEd from PUBLIC. The owner bypasses RLS, so EVERY read inside names org_id = the franchisee explicitly.
--   4. The reader check (K1, QO-1): the caller's org is app_current_org(); app.person_id is a live person OF that org; that person has an active super_admin role there OR an active
--      person-level view_franchise_sales grant (revoked_at IS NULL, store_id IS NULL); an agreement has org_id = the franchisee and franchisor_org_id = the caller's org. Any failure is
--      42501 in words, no rows, no log row. Production Ian is role admin + grants (P0187b), so a role-only check would refuse him.
--   5. Break-glass sign-in (K4, QO-4): an AFTER INSERT trigger on sessions. Every session created for an agreement's franchisor person (email, PIN, Employee-ID tablet: all three
--      paths reach the one sessions insert) writes one break_glass_sign_in row in the same transaction; it rolls back with the session. Nothing to forget, nothing to forge.
--   6. RLS on both tables: ENABLE + FORCE; one policy each, FOR SELECT, org_id = app_current_org() OR franchisor_org_id = app_current_org(). No write policy and no write privilege for
--      the app role (V12): the definers and the trigger are the only door. Registry kind dual_org_counterparty (A10), cutover class keep for both (QO-7).
--
-- FORGING log_break_glass_approval. The application role may call it. The most it can do is ADD a break_glass_approval row naming the agreement's franchisor person (and only when the
-- caller's organisation is the franchisee). That can over-report, never hide: nothing is read, changed or erased. It is stated here so the review does not have to rediscover it.
--
-- TRIGGER CLASSES (triggers/registry.ts). franchise_access_log_append_only_trg is history_guard / ENABLE ALWAYS (they decide from nothing
-- but the operation, so session_replication_role = replica cannot be used to rewrite the log). franchise_agreements_app_guard_trg is a
-- validator / origin (they decide from the calling role). sessions_break_glass_log_trg is derivation / origin (it derives a log row from a session row).
--
-- LOCK BUDGET (ADR-012 s5).
--   * First statement: SET LOCAL lock_timeout = '5s' (resets at commit); the last statement is RESET lock_timeout. A deploy that hits it is re-run, never edited.
--   * The live tables touched: sessions (CREATE TRIGGER takes SHARE ROW EXCLUSIVE on it, so a sign-in waits) and, through the new tables' foreign keys, organizations, persons and stores
--     (CREATE TABLE with foreign keys takes SHARE ROW EXCLUSIVE on each referenced table, so writes to them wait). Drizzle applies pending migrations in ONE transaction, so all of these locks last
--     until COMMIT; lock_timeout bounds only the WAIT for a lock, not how long it is then held. Both new tables are empty. Do not deploy 05:30-07:00 Manila (D8: the POS import window).
--   * No precheck: new tables plus one trigger.
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "franchise_agreements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"franchisor_org_id" uuid NOT NULL,
	"franchisor_person_id" uuid NOT NULL,
	"sales_visible_from" date NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_agreements_org_id_key" UNIQUE ("org_id"),
	CONSTRAINT "franchise_agreements_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "franchise_agreements_org_franchisor_id_unique" UNIQUE ("org_id", "franchisor_org_id", "id"),
	CONSTRAINT "franchise_agreements_franchisor_person_id_key" UNIQUE ("franchisor_person_id"),
	CONSTRAINT "franchise_agreements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_agreements_franchisor_org_id_organizations_id_fk" FOREIGN KEY ("franchisor_org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_agreements_franchisor_person_id_same_org_fk" FOREIGN KEY ("org_id", "franchisor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_agreements_franchisor_differs_check" CHECK ("franchisor_org_id" <> "org_id")
);
--> statement-breakpoint
CREATE TABLE "franchise_access_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"franchisor_org_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"what" text NOT NULL,
	"reader_person_id" uuid,
	"franchisee_person_id" uuid,
	"person_name" text NOT NULL,
	"range_from" date,
	"range_to" date,
	"store_id" uuid,
	"session_id" uuid,
	"credential_kind" text,
	"capability" text,
	"rows_returned" integer,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_access_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_access_log_franchisor_org_id_organizations_id_fk" FOREIGN KEY ("franchisor_org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_access_log_agreement_id_same_pair_fk" FOREIGN KEY ("org_id", "franchisor_org_id", "agreement_id") REFERENCES "franchise_agreements" ("org_id", "franchisor_org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_access_log_reader_person_id_franchisor_org_fk" FOREIGN KEY ("franchisor_org_id", "reader_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_access_log_franchisee_person_id_same_org_fk" FOREIGN KEY ("org_id", "franchisee_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_access_log_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "franchise_access_log_what_check" CHECK ("what" IN ('sales_daily', 'stock_levels', 'break_glass_sign_in', 'break_glass_approval')),
	CONSTRAINT "franchise_access_log_person_name_check" CHECK (char_length(btrim("person_name")) > 0),
	CONSTRAINT "franchise_access_log_rows_returned_check" CHECK ("rows_returned" IS NULL OR "rows_returned" >= 0),
	CONSTRAINT "franchise_access_log_reason_check" CHECK ("reason" IS NULL OR (char_length("reason") >= 1 AND char_length("reason") <= 500)),
	CONSTRAINT "franchise_access_log_credential_kind_check" CHECK ("credential_kind" IS NULL OR "credential_kind" IN ('pin', 'firebase', 'biometric')),
	CONSTRAINT "franchise_access_log_capability_check" CHECK ("capability" IS NULL OR (char_length(btrim("capability")) >= 1 AND char_length("capability") <= 100)),
	CONSTRAINT "franchise_access_log_sales_daily_shape_check" CHECK ("what" <> 'sales_daily' OR (
		"reader_person_id" IS NOT NULL AND "franchisee_person_id" IS NULL AND "range_from" IS NOT NULL AND "range_to" IS NOT NULL AND "range_from" <= "range_to"
		AND "store_id" IS NULL AND "session_id" IS NULL AND "credential_kind" IS NULL AND "capability" IS NULL AND "rows_returned" IS NOT NULL)),
	CONSTRAINT "franchise_access_log_stock_levels_shape_check" CHECK ("what" <> 'stock_levels' OR (
		"reader_person_id" IS NOT NULL AND "franchisee_person_id" IS NULL AND "range_from" IS NULL AND "range_to" IS NULL
		AND "session_id" IS NULL AND "credential_kind" IS NULL AND "capability" IS NULL AND "rows_returned" IS NOT NULL)),
	CONSTRAINT "franchise_access_log_sign_in_shape_check" CHECK ("what" <> 'break_glass_sign_in' OR (
		"reader_person_id" IS NULL AND "franchisee_person_id" IS NOT NULL AND "range_from" IS NULL AND "range_to" IS NULL
		AND "session_id" IS NOT NULL AND "credential_kind" IS NOT NULL AND "capability" IS NULL AND "rows_returned" IS NULL AND "reason" IS NULL)),
	CONSTRAINT "franchise_access_log_approval_shape_check" CHECK ("what" <> 'break_glass_approval' OR (
		"reader_person_id" IS NULL AND "franchisee_person_id" IS NOT NULL AND "range_from" IS NULL AND "range_to" IS NULL
		AND "session_id" IS NULL AND "credential_kind" IS NULL AND "capability" IS NOT NULL AND "rows_returned" IS NULL AND "reason" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "franchise_access_log_org_occurred_idx" ON "franchise_access_log" ("org_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_access_log_session_id_key" ON "franchise_access_log" ("session_id") WHERE "session_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "franchise_agreements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "franchise_agreements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "franchise_agreements_select" ON "franchise_agreements" FOR SELECT
	USING ("org_id" = app_current_org() OR "franchisor_org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "franchise_access_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "franchise_access_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "franchise_access_log_select" ON "franchise_access_log" FOR SELECT
	USING ("org_id" = app_current_org() OR "franchisor_org_id" = app_current_org());
--> statement-breakpoint
REVOKE ALL ON "franchise_agreements", "franchise_access_log" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT ON "franchise_agreements", "franchise_access_log" TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "franchise_access_log_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION 'The franchise access log is append-only: % of a log row is never permitted, for any role.', TG_OP;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "franchise_access_log_append_only"() FROM PUBLIC, "shareat_app";
--> statement-breakpoint
CREATE TRIGGER "franchise_access_log_append_only_trg"
	BEFORE UPDATE OR DELETE ON "franchise_access_log"
	FOR EACH ROW EXECUTE FUNCTION "franchise_access_log_append_only"();
--> statement-breakpoint
ALTER TABLE "franchise_access_log" ENABLE ALWAYS TRIGGER "franchise_access_log_append_only_trg";
--> statement-breakpoint
CREATE FUNCTION "franchise_agreements_app_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	IF current_user = 'shareat_app' THEN
		RAISE EXCEPTION 'A franchise agreement is written by the owner path only; the application cannot change or remove one.' USING ERRCODE = '42501';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	ELSIF TG_OP = 'UPDATE' THEN
		RETURN NEW;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "franchise_agreements_app_guard"() FROM PUBLIC, "shareat_app";
--> statement-breakpoint
CREATE TRIGGER "franchise_agreements_app_guard_trg"
	BEFORE UPDATE OR DELETE ON "franchise_agreements"
	FOR EACH ROW EXECUTE FUNCTION "franchise_agreements_app_guard"();
--> statement-breakpoint
CREATE FUNCTION "franchise_reader_check"("p_franchisee_org" uuid) RETURNS "franchise_agreements"
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
	IF NOT EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = v_person AND p."org_id" = v_org AND p."is_active") THEN
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION "franchise_reader_check"(uuid) FROM PUBLIC, "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "franchise_franchisees"() RETURNS TABLE ("franchisee_org_id" uuid, "franchisee_name" text, "sales_visible_from" date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
	PERFORM franchise_reader_check(NULL::uuid);
	RETURN QUERY
	SELECT f."org_id", o."name", f."sales_visible_from"
	FROM "franchise_agreements" f
	JOIN "organizations" o ON o."id" = f."org_id"
	WHERE f."franchisor_org_id" = app_current_org() AND (f."ended_on" IS NULL OR f."ended_on" > (now() AT TIME ZONE 'Asia/Manila')::date)
	ORDER BY o."name", f."org_id";
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "franchise_franchisees"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "franchise_franchisees"() TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "franchise_sales_daily"("p_franchisee_org" uuid, "p_from" date, "p_to" date, "p_reason" text DEFAULT NULL)
RETURNS TABLE (
	"row_kind" text, "store_id" uuid, "store_name" text, "business_date" date, "day_status" text,
	"gross_sales" numeric, "discounts" numeric, "comps" numeric, "refunds" numeric, "net_sales" numeric,
	"cash_collected" numeric, "online_collected" numeric, "credit_sales" numeric, "channel_name" text, "channel_amount" numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
	v_agreement uuid;
	v_franchisor uuid;
	v_visible_from date;
	v_person uuid;
	v_name text;
	v_reason text;
BEGIN
	SELECT g."id", g."franchisor_org_id", g."sales_visible_from" INTO v_agreement, v_franchisor, v_visible_from FROM franchise_reader_check(p_franchisee_org) g;
	IF p_from IS NULL OR p_to IS NULL THEN
		RAISE EXCEPTION 'Both a start date and an end date are needed.' USING ERRCODE = '22023';
	END IF;
	IF p_to < p_from THEN
		RAISE EXCEPTION 'The end date % comes before the start date %.', p_to, p_from USING ERRCODE = '22023';
	END IF;
	IF p_from < v_visible_from THEN
		RAISE EXCEPTION 'Sales of this franchise are visible from %; the range you asked for starts on %.', v_visible_from, p_from USING ERRCODE = '22023';
	END IF;
	IF p_to - p_from + 1 > 366 THEN
		RAISE EXCEPTION 'A range may cover at most 366 days; you asked for % days.', p_to - p_from + 1 USING ERRCODE = '22023';
	END IF;
	v_reason := nullif(btrim(p_reason), '');
	IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
		RAISE EXCEPTION 'The reason may be at most 500 characters.' USING ERRCODE = '22023';
	END IF;
	v_person := nullif(current_setting('app.person_id', true), '')::uuid;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = v_person AND p."org_id" = app_current_org();
	-- ONE statement: the days are read once (one snapshot), the log row is written from that same read, and the rows come back. The log INSERT is a data-modifying CTE,
	-- so it runs whether or not the outer query reads it: no look without a row.
	RETURN QUERY
	WITH days AS MATERIALIZED (
		SELECT d."id" AS day_id, d."store_id" AS d_store_id, st."name" AS d_store_name, d."business_date" AS d_date, d."status" AS d_status,
			(d."total_sales" + CASE WHEN d."source" = 'pos_v1_day_feed' THEN coalesce(plat.amount, 0) ELSE 0 END)::numeric(14,2) AS gross,
			(d."senior_discount" + d."pwd_discount" + d."other_discount")::numeric(14,2) AS disc,
			d."comps"::numeric(14,2) AS d_comps, d."refunds"::numeric(14,2) AS d_refunds,
			d."cash_collected"::numeric(14,2) AS d_cash, d."online_collected"::numeric(14,2) AS d_online, d."credit_sales"::numeric(14,2) AS d_credit
		FROM "sales_days" d
		JOIN "stores" st ON st."id" = d."store_id" AND st."org_id" = d."org_id"
		LEFT JOIN LATERAL (
			SELECT sum(c."amount") AS amount
			FROM "sales_day_channels" c
			JOIN "sales_channels" ch ON ch."id" = c."channel_id" AND ch."org_id" = d."org_id"
			WHERE c."sales_day_id" = d."id" AND NOT ch."is_remitted_daily" AND NOT c."no_sales"
		) plat ON true
		WHERE d."org_id" = p_franchisee_org AND d."business_date" BETWEEN p_from AND p_to AND d."status" <> 'voided'
	), logged AS (
		INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "reader_person_id", "person_name", "range_from", "range_to", "rows_returned", "reason")
		SELECT p_franchisee_org, v_franchisor, v_agreement, 'sales_daily', v_person, v_name, p_from, p_to, (SELECT count(*) FROM days)::int, v_reason
		RETURNING "id"
	)
	SELECT u.row_kind, u.store_id, u.store_name, u.business_date, u.day_status, u.gross_sales, u.discounts, u.comps, u.refunds, u.net_sales,
		u.cash_collected, u.online_collected, u.credit_sales, u.channel_name, u.channel_amount
	FROM (
		SELECT 'day'::text AS row_kind, y.d_store_id AS store_id, y.d_store_name AS store_name, y.d_date AS business_date, y.d_status AS day_status,
			y.gross AS gross_sales, y.disc AS discounts, y.d_comps AS comps, y.d_refunds AS refunds,
			(y.gross - y.disc - y.d_comps - y.d_refunds)::numeric(14,2) AS net_sales,
			y.d_cash AS cash_collected, y.d_online AS online_collected, y.d_credit AS credit_sales,
			NULL::text AS channel_name, NULL::numeric AS channel_amount, 0 AS ord
		FROM days y
		UNION ALL
		SELECT 'channel'::text, y.d_store_id, y.d_store_name, y.d_date, y.d_status,
			NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
			ch."name", c."amount"::numeric(14,2), 1
		FROM days y
		JOIN "sales_day_channels" c ON c."sales_day_id" = y.day_id
		JOIN "sales_channels" ch ON ch."id" = c."channel_id" AND ch."org_id" = p_franchisee_org
	) u
	ORDER BY u.business_date, u.store_name, u.ord, u.channel_name;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "franchise_sales_daily"(uuid, date, date, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "franchise_sales_daily"(uuid, date, date, text) TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "franchise_stock_levels"("p_franchisee_org" uuid, "p_store" uuid DEFAULT NULL, "p_reason" text DEFAULT NULL)
RETURNS TABLE (
	"store_id" uuid, "store_name" text, "item_name" text, "base_unit" text, "on_hand" numeric,
	"threshold" numeric, "below_threshold" boolean, "as_of" timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
	v_agreement uuid;
	v_franchisor uuid;
	v_person uuid;
	v_name text;
	v_reason text;
BEGIN
	SELECT g."id", g."franchisor_org_id" INTO v_agreement, v_franchisor FROM franchise_reader_check(p_franchisee_org) g;
	IF p_store IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "stores" s WHERE s."id" = p_store AND s."org_id" = p_franchisee_org) THEN
		RAISE EXCEPTION 'That store does not belong to this franchise.' USING ERRCODE = '42501';
	END IF;
	v_reason := nullif(btrim(p_reason), '');
	IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
		RAISE EXCEPTION 'The reason may be at most 500 characters.' USING ERRCODE = '22023';
	END IF;
	v_person := nullif(current_setting('app.person_id', true), '')::uuid;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = v_person AND p."org_id" = app_current_org();
	RETURN QUERY
	WITH oh AS (
		SELECT m."store_id" AS m_store, m."item_id" AS m_item, sum(m."quantity") AS qty
		FROM "stock_movements" m
		WHERE m."org_id" = p_franchisee_org AND (p_store IS NULL OR m."store_id" = p_store)
		GROUP BY m."store_id", m."item_id"
	), th AS (
		SELECT t."store_id" AS t_store, t."item_id" AS t_item, t."low_stock_threshold" AS line
		FROM "store_item_thresholds" t
		WHERE t."org_id" = p_franchisee_org AND (p_store IS NULL OR t."store_id" = p_store)
	), keys AS (
		SELECT oh.m_store AS k_store, oh.m_item AS k_item FROM oh
		UNION
		SELECT th.t_store, th.t_item FROM th
	), shown AS MATERIALIZED (
		SELECT k.k_store AS s_store, st."name" AS s_store_name, i."name" AS s_item_name, i."base_unit" AS s_unit,
			coalesce(oh.qty, 0)::numeric(14,3) AS s_on_hand, th.line::numeric(14,3) AS s_line,
			(th.line IS NOT NULL AND coalesce(oh.qty, 0) <= th.line) AS s_below
		FROM keys k
		JOIN "items" i ON i."id" = k.k_item AND i."org_id" = p_franchisee_org AND i."status" = 'active'
		JOIN "stores" st ON st."id" = k.k_store AND st."org_id" = p_franchisee_org
		LEFT JOIN oh ON oh.m_store = k.k_store AND oh.m_item = k.k_item
		LEFT JOIN th ON th.t_store = k.k_store AND th.t_item = k.k_item
		WHERE coalesce(oh.qty, 0) <> 0 OR th.line IS NOT NULL
	), logged AS (
		INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "reader_person_id", "person_name", "store_id", "rows_returned", "reason")
		SELECT p_franchisee_org, v_franchisor, v_agreement, 'stock_levels', v_person, v_name, p_store, (SELECT count(*) FROM shown)::int, v_reason
		RETURNING "id"
	)
	SELECT x.s_store, x.s_store_name, x.s_item_name, x.s_unit, x.s_on_hand, x.s_line, x.s_below, now()
	FROM shown x
	ORDER BY x.s_store_name, x.s_item_name;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "franchise_stock_levels"(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "franchise_stock_levels"(uuid, uuid, text) TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "log_break_glass_approval"("p_person" uuid, "p_capability" text, "p_store" uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_agreement uuid;
	v_org uuid;
	v_franchisor uuid;
	v_name text;
	v_store uuid;
BEGIN
	IF p_person IS NULL THEN
		RETURN false;
	END IF;
	SELECT f."id", f."org_id", f."franchisor_org_id" INTO v_agreement, v_org, v_franchisor FROM "franchise_agreements" f WHERE f."franchisor_person_id" = p_person;
	IF NOT FOUND OR v_org IS DISTINCT FROM app_current_org() THEN
		RETURN false;
	END IF;
	-- Only the franchisor's own person logs his own approval: the caller's signed-in person must BE p_person (audit A1). Nobody else can write a row in his name.
	IF nullif(current_setting('app.person_id', true), '')::uuid IS DISTINCT FROM p_person THEN
		RAISE EXCEPTION 'Only the franchisor person himself can log his own approval.' USING ERRCODE = '42501';
	END IF;
	IF p_capability IS NULL OR NOT (p_capability = ANY (ARRAY[
		'record_sale', 'submit_sales_day', 'verify_sales_day', 'void_sales_day',
		'record_statutory_discount', 'void_statutory_discount', 'approve_pos_correction', 'accept_remittance',
		'record_till_count', 'resolve_till_variance', 'transfer_funds', 'create_expense',
		'edit_own_expense', 'edit_any_expense', 'void_expense', 'approve_expense',
		'record_stock_movement', 'adjust_inventory', 'record_wastage', 'charge_staff_for_discrepancy',
		'transfer_stock', 'void_transfer', 'record_supplier_return', 'void_supplier_return',
		'apply_supplier_credit', 'record_customer_return', 'void_customer_return', 'apply_customer_credit',
		'refund_customer', 'confirm_receipt', 'resolve_trade_discrepancy', 'set_item_threshold',
		'post_order_message', 'place_branch_order', 'fulfil_branch_order', 'dispatch_branch_order',
		'manage_locations', 'receive_delivery', 'allow_over_receipt', 'post_usage',
		'void_usage_record', 'open_count_session', 'commit_count', 'approve_supplier',
		'approve_buyer', 'set_credit_limit', 'manage_expense_budgets', 'manage_recurring_expenses',
		'override_credit_limit', 'record_ap_payment', 'record_ar_collection', 'write_off_receivable',
		'run_cutover', 'manage_items', 'approve_item', 'record_supplier_invoice',
		'verify_supplier_invoice', 'void_supplier_invoice', 'create_wholesale_order', 'dispatch_wholesale_order',
		'view_financial_reports', 'view_trial_balance', 'reverse_entry', 'close_period',
		'override_period_lock', 'create_missing_period', 'book_missed_month', 'post_journal_entry',
		'enrol_staff', 'manage_users', 'manage_stores', 'grant_capability',
		'manage_attendance', 'view_leave_document', 'set_pay_rate', 'run_payroll',
		'manage_payroll_rates', 'view_staff_signature', 'pair_pos_tablet', 'provision_clock_terminal',
		'manage_store_settings', 'set_cash_policy', 'set_channel_payout', 'manage_price_lists',
		'view_menu', 'add_menu_item', 'manage_menu', 'request_menu_item',
		'set_menu_price', 'set_menu_depletion', 'switch_usage_source', 'manage_commissary_offerings',
		'manage_commissary_map', 'manage_fixed_assets', 'run_depreciation', 'manage_prepaid_items',
		'run_amortisation', 'manage_chart_of_accounts', 'post_production', 'edit_posted_production',
		'void_production', 'record_order_wastage', 'resolve_order_wastage', 'charge_staff_for_wastage',
		'reverse_auto_charge', 'manage_recipes', 'manage_pos_map', 'request_pos_map',
		'decide_pos_map_request', 'finalize_pos_usage_pull', 'unlink_store_from_pos', 'verify_own_sales_day',
		'view_activity_log', 'view_activity_log_restricted', 'verify_own_supplier_invoice', 'cross_org_access',
		'view_franchise_sales', 'view_franchise_access_log'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "log_break_glass_approval"(uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "log_break_glass_approval"(uuid, text, uuid) TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "sessions_break_glass_log"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_agreement uuid;
	v_org uuid;
	v_franchisor uuid;
	v_name text;
	v_store uuid;
BEGIN
	SELECT f."id", f."org_id", f."franchisor_org_id" INTO v_agreement, v_org, v_franchisor FROM "franchise_agreements" f WHERE f."franchisor_person_id" = NEW."person_id";
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = NEW."person_id" AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = NEW."store_id" AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "session_id", "credential_kind")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_sign_in', NEW."person_id", v_name, v_store, NEW."id", NEW."credential_kind");
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "sessions_break_glass_log"() FROM PUBLIC, "shareat_app";
--> statement-breakpoint
CREATE TRIGGER "sessions_break_glass_log_trg"
	AFTER INSERT ON "sessions"
	FOR EACH ROW EXECUTE FUNCTION "sessions_break_glass_log"();
--> statement-breakpoint
RESET lock_timeout;
