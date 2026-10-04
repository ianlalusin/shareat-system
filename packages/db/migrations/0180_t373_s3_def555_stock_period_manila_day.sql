-- 0180 — T-373 S3 (DEF-555), docs/tasks/373-money-follow-ups.md section S3, ruling R5.
--
-- stock_movements_check_period_open judged a movement by the UTC date of moved_at. The business day is Manila
-- (UTC+8), so between 00:00 and 08:00 Manila on the 1st a `now`-stamped writer (returns, voids, in-store
-- transfers) was refused whenever the month before was closed: its UTC date was still the last day of that
-- month. The stock day is the Manila business day, midnight to midnight, exactly toBusinessDate; 'Asia/Manila'
-- is hard-coded as 0112 does, not stores.timezone, because the TS business date is fixed Manila and must agree.
--
-- Only `now`-stamped writers change. Date-stamped movements are written at UTC midnight of their business
-- date; 08:00 Manila the same day is still that date, so they land in the same period as before. A `now`-stamped
-- movement between 16:00 and 24:00 UTC on a month's last day is now judged against the NEXT month (its Manila
-- date): accepted where that month is open, newly refused where it is closed or locked. Both RAISE sentences
-- are byte-identical to 0145's. The trigger
-- itself is not re-created; only its function is replaced.
--
-- PRECHECK: none required. The function runs only on INSERT into an append-only table, so it validates no
-- existing row. For the record, rows whose Manila and UTC dates fall in different periods stand as written:
--   select count(*) from stock_movements m
--   join fiscal_periods u on u.org_id = m.org_id and (m.moved_at at time zone 'UTC')::date between u.starts_on and u.ends_on
--   join fiscal_periods p on p.org_id = m.org_id and (m.moved_at at time zone 'Asia/Manila')::date between p.starts_on and p.ends_on
--   where u.id <> p.id;
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE OR REPLACE FUNCTION "stock_movements_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
	is_override_context boolean;
BEGIN
	SELECT "status" INTO period_status
	FROM "fiscal_periods"
	WHERE "org_id" = NEW."org_id"
	  AND (NEW."moved_at" AT TIME ZONE 'Asia/Manila')::date BETWEEN "starts_on" AND "ends_on";

	IF period_status IS NOT NULL AND period_status <> 'open' THEN
		-- Read-only: chooses which SENTENCE to raise. Never lets the INSERT through (0145; DEF-302; bible row 193).
		is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';

		IF is_override_context THEN
			RAISE EXCEPTION 'cannot move stock into a % period (moved_at = %) -- the period-override capability does not extend to stock movements: back-dating one recomputes inventory layers and cost of goods sold, a decision the override was never authorised to make', period_status, NEW."moved_at";
		ELSE
			RAISE EXCEPTION 'cannot move stock into a % period (moved_at = %)', period_status, NEW."moved_at";
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
