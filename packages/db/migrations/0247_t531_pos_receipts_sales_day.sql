-- 0247 - T-531 (POS v2 day close), docs/tasks/531-pos-day-close.md R1 and ruling 2 (8 Nov 2026), bible rows 270, 436, 449.
--
-- WHY. The Z derives an ERP sales day from the POS receipts (source = 'pos_receipts', row 270). The 0185 figure-lock refuses EVERY sales-day INSERT for a store
-- linked to v1 unless the source is the feed, and Lipa is linked, so the derivation could never write. The same lock would refuse the day's tender rows (0185's
-- child-row function says "the store must be unlinked" for anything that is not a feed day). And nothing stopped the 06:00 v1 import (T-396) from also booking a
-- day the new POS now owns, which is the double-book row 436 names.
--
-- WHAT CHANGES (two CREATE OR REPLACE; the triggers themselves are NOT recreated, every existing branch of both bodies is 0187's, verbatim):
--   sales_days_check_figure_lock() - BEFORE INSERT OR UPDATE on sales_days
--     INSERT  ADDED  source = 'pos_receipts' is allowed ONLY inside the derivation flag (app.sales_day_derivation = 'on') AND with pos_day_close_id set AND when the
--                    store's pos_stores row is live AND business_date >= live_from. The flag is ALWAYS required (linked or not). Test mode never books; a store
--                    switched off again, or a date before live_from, is refused (SQLSTATE 23514, constraint sales_days_figures_locked).
--     INSERT  ADDED  the row-436 guard, constraint sales_days_pos_live_feed_guard: a 'pos_v1_day_feed' day for a store whose pos_stores row is live, on or after
--                    live_from, is refused with "This store is on the new POS from <date>; its sales days come from POS receipts." A feed day BEFORE live_from,
--                    and any feed day of a test-mode or off store, behave exactly as before.
--     UPDATE  ADDED  a day with source = 'pos_receipts' changes its figures only inside the flag while open or submitted (a derived day must never be hand-edited,
--                    linked store or not); a verified day is never rewritten. The typed-day and feed-day branches are unchanged.
--   sales_day_child_row_allowed() - the tender / channel guard
--     ADDED  a TENDER row (p_remitted IS NULL) of a 'pos_receipts' day is allowed only inside the flag while the day is open or submitted (the derivation writes it);
--            a PLATFORM channel row (non-remitted) of such a day is allowed while it is open or submitted, as on a feed day; a remitted channel row is never (the POS
--            has none). Every other day keeps today's rule.
--
-- UNCHANGED: the trigger names and definitions (sales_days_figure_lock stays BEFORE INSERT OR UPDATE), the 0188 verify trigger, every grant, no table, no index.
-- The trigger registry entries stay as they are (name, table, mode, kind do not change; only the function bodies do, and the registry pins no body).
-- The link is read as the INVOKER, under RLS, exactly as 0185 reads it (no SECURITY DEFINER): pos_stores is read the same way, so with no organisation
-- context and a role that cannot bypass RLS the read finds no row and a 'pos_receipts' insert fails closed (refused).
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE OR REPLACE FUNCTION "sales_days_check_figure_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	flag_on boolean := coalesce(nullif(current_setting('app.sales_day_derivation', true), ''), 'off') = 'on';
	live_date date;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- T-531: a day derived from the POS receipts (the Z). The flag is always required; the store must be live and the date on or after live_from.
		IF NEW.source = 'pos_receipts' THEN
			IF NOT flag_on OR NEW.pos_day_close_id IS NULL OR NOT EXISTS (
				SELECT 1 FROM "pos_stores" ps
				 WHERE ps.store_id = NEW.store_id AND ps.mode = 'live' AND ps.live_from IS NOT NULL AND NEW.business_date >= ps.live_from
			) THEN
				RAISE EXCEPTION 'Sales figures for this store come only from POS (T-531): a POS day is created only by the day close, for a live store, on or after its live date.'
					USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
			END IF;
			RETURN NEW;
		END IF;
		-- T-531, row 436: the new POS owns the days from live_from, so the v1 import must not also book them.
		IF NEW.source = 'pos_v1_day_feed' THEN
			SELECT ps.live_from INTO live_date FROM "pos_stores" ps WHERE ps.store_id = NEW.store_id AND ps.mode = 'live';
			IF FOUND AND live_date IS NOT NULL AND NEW.business_date >= live_date THEN
				RAISE EXCEPTION 'This store is on the new POS from %; its sales days come from POS receipts.', to_char(live_date, 'YYYY-MM-DD')
					USING ERRCODE = '23514', CONSTRAINT = 'sales_days_pos_live_feed_guard';
			END IF;
		END IF;
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
	ELSIF OLD.source = 'pos_receipts' THEN
		IF NOT flag_on OR OLD.status NOT IN ('open', 'submitted') THEN
			RAISE EXCEPTION 'Sales figures of a day from the POS change only inside the derivation, while open or submitted (T-531).'
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
	-- T-531: a day derived from the POS receipts. Its TENDER rows are written by the derivation only, while the day is open or submitted. It owns no remitted channel row
	-- (the POS has none); a PLATFORM row (non-remitted, typed beside it as on a feed day, R8) may be written while the day is open or submitted.
	IF d_source = 'pos_receipts' THEN
		IF p_remitted IS NULL THEN
			RETURN flag_on AND d_status IN ('open', 'submitted');
		END IF;
		RETURN p_remitted = false AND d_status IN ('open', 'submitted');
	END IF;
	RETURN NOT "sales_day_store_is_linked"(d_store, p_constraint);
END;
$$;
