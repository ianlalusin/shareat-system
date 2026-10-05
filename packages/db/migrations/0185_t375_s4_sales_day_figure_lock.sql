-- 0185 - T-375 S4 (DEF-586), docs/tasks/375-pos-v1-day-feed.md ruling R6 and section S4.
--
-- ENFORCEMENT ONLY (0183 was the structure): the link-aware lock on a sales day's figures, tender rows and channel
-- rows. A store is LINKED when it has a row in pos_v1_store_links; the link row is the per-store switch (I10).
--
--   sales_days BEFORE INSERT   linked store: only the derivation (flag on) may insert, and only a feed day.
--                              unlinked store: a feed day is refused (it needs a link); a typed day is allowed.
--   sales_days BEFORE UPDATE   when a protected column changes (store_id, business_date, source, pos_v1_day_feed_id,
--                              pos_sourced, pos_sourced_at, the twelve figures, refunds): a feed day needs the flag AND
--                              an open/submitted status; a typed day is writable only while its store is UNLINKED;
--                              `source` never changes. Status, sign-off and journal columns are never locked.
--   sales_day_tenders          INSERT/UPDATE/DELETE: a feed day needs the flag AND an open/submitted
--                              status; a typed day needs the store unlinked.
--   sales_day_channels         INSERT/UPDATE/DELETE: a typed day needs the store unlinked; on a feed day a channel
--                              REMITTED daily needs the flag and an open/submitted day, and a non-remitted (platform, R8) row needs the day open
--                              or submitted.
--   pos_v1_store_links BEFORE UPDATE   store_id never changes.
--
-- The flag is `app.sales_day_derivation`, a transaction-local setting the domain's withSalesDayDerivation turns on
-- around a derivation write (read here as coalesce(nullif(current_setting(.., true), ''), 'off')). The link is read
-- as the INVOKER, under RLS: NO SECURITY DEFINER (R6, W2) - the owner role bypasses RLS and a definer function would
-- see every org's links. If app_current_org() is NULL and the session role is neither superuser nor BYPASSRLS the
-- lookup fails closed (defence in depth: RLS already stops such a session first).
--
-- Every refusal is ERRCODE 23514 with the CONSTRAINT name the app maps to a sentence
-- (apps/erp/src/lib/constraint-messages.ts): sales_days_figures_locked, sales_day_tenders_locked,
-- sales_day_channels_locked, pos_v1_store_links_store_fixed.
--
-- The `source` DEFAULT is KEPT (legacy_typed), so every existing raw insert on an unlinked store still works.
-- TRUNCATE (the cutover purge) fires no row trigger. No table is added, so no RLS registry / classification change.
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

-- The one place the link is read. Fails closed with no org context unless the role bypasses RLS.
CREATE FUNCTION "sales_day_store_is_linked"(p_store_id uuid, p_constraint text) RETURNS boolean
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
	RETURN EXISTS (SELECT 1 FROM "pos_v1_store_links" WHERE store_id = p_store_id);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "sales_days_check_figure_lock"() RETURNS trigger
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
		IF NOT flag_on OR OLD.status NOT IN ('open', 'submitted') THEN
			RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a feed day changes only inside the derivation, while open or submitted.'
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
CREATE TRIGGER "sales_days_figure_lock"
	BEFORE INSERT OR UPDATE ON "sales_days"
	FOR EACH ROW EXECUTE FUNCTION "sales_days_check_figure_lock"();
--> statement-breakpoint
-- A child row (tender or channel) of a sales day. `p_remitted` is NULL for a tender.
CREATE FUNCTION "sales_day_child_row_allowed"(p_day_id uuid, p_remitted boolean, p_constraint text) RETURNS boolean
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
		RETURN flag_on AND d_status IN ('open', 'submitted'); -- verified is never rewritten (RULES 6.3), flag or not
	END IF;
	RETURN NOT "sales_day_store_is_linked"(d_store, p_constraint);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "sales_day_tenders_check_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') AND NOT "sales_day_child_row_allowed"(OLD.sales_day_id, NULL, 'sales_day_tenders_locked') THEN
		RAISE EXCEPTION 'Tender rows for this store come only from POS (T-375, R6).'
			USING ERRCODE = '23514', CONSTRAINT = 'sales_day_tenders_locked';
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') AND NOT "sales_day_child_row_allowed"(NEW.sales_day_id, NULL, 'sales_day_tenders_locked') THEN
		RAISE EXCEPTION 'Tender rows for this store come only from POS (T-375, R6).'
			USING ERRCODE = '23514', CONSTRAINT = 'sales_day_tenders_locked';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sales_day_tenders_lock"
	BEFORE INSERT OR UPDATE OR DELETE ON "sales_day_tenders"
	FOR EACH ROW EXECUTE FUNCTION "sales_day_tenders_check_lock"();
--> statement-breakpoint
CREATE FUNCTION "sales_day_channels_check_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	remitted boolean;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT is_remitted_daily INTO remitted FROM "sales_channels" WHERE id = OLD.channel_id;
		IF NOT "sales_day_child_row_allowed"(OLD.sales_day_id, remitted, 'sales_day_channels_locked') THEN
			RAISE EXCEPTION 'Channel rows for this store come only from POS (T-375, R6).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_day_channels_locked';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT is_remitted_daily INTO remitted FROM "sales_channels" WHERE id = NEW.channel_id;
		IF NOT "sales_day_child_row_allowed"(NEW.sales_day_id, remitted, 'sales_day_channels_locked') THEN
			RAISE EXCEPTION 'Channel rows for this store come only from POS (T-375, R6).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_day_channels_locked';
		END IF;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sales_day_channels_lock"
	BEFORE INSERT OR UPDATE OR DELETE ON "sales_day_channels"
	FOR EACH ROW EXECUTE FUNCTION "sales_day_channels_check_lock"();
--> statement-breakpoint
CREATE FUNCTION "pos_v1_store_links_check_store_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.store_id IS DISTINCT FROM OLD.store_id THEN
		RAISE EXCEPTION 'A POS link never moves to another store (T-375, R6).'
			USING ERRCODE = '23514', CONSTRAINT = 'pos_v1_store_links_store_fixed';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "pos_v1_store_links_store_fixed"
	BEFORE UPDATE ON "pos_v1_store_links"
	FOR EACH ROW EXECUTE FUNCTION "pos_v1_store_links_check_store_fixed"();
