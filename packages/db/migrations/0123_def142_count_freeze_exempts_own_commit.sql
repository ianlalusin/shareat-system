-- 0123 — DEF-142: the count freeze must not refuse the count's OWN resolving write.
--
-- HAND-WRITTEN, like 0020-0122 (DEF-073 — never `db:generate` on this repo).
--
-- ⭐ 0068's `stock_movements_check_not_frozen` refuses ANY insert into a room an active session
-- holds — including the `count_adjustment` movement `commitCountSession` writes to resolve that
-- very session. Every counted line's room is, by construction, one of the session's own frozen
-- rooms, so a real count could never commit: the freeze the session created blocked its own
-- resolution. The engine's own tests never noticed because they froze a DIFFERENT room than the
-- one they counted ("freeze a different room so the write can land"), and until 2026-09-03 no
-- screen existed to try a real one (DEF-135).
--
-- The exemption is exactly one shape: a `count_adjustment` movement whose `source_type` is
-- `count` and whose `source_id` names an ACTIVE session that holds THIS room. A count movement
-- from a session that does not hold the room, or from a session already closed or cancelled
-- (a stale id would otherwise open the freeze a later session placed on the same room), stays
-- refused, and every other kind of write into a frozen room is untouched — the tests in
-- `count-sessions.test.ts` pin all three directions.
--
-- ⚠️ `source_id` is compared as TEXT on both sides. A cast of an arbitrary `source_id` to uuid
-- would throw on any non-uuid source and plpgsql does not short-circuit an `IF a AND b`, so the
-- exemption test is kept separate from the kind/type guard and never casts.
CREATE OR REPLACE FUNCTION "stock_movements_check_not_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	frozen boolean;
	own_count boolean;
BEGIN
	IF COALESCE(NULLIF(current_setting('app.bypass_count_freeze', true), ''), 'off') = 'on' THEN
		RETURN NEW;
	END IF;

	-- ⭐ DEF-142: the session's own variance write is what the freeze exists to make possible.
	IF NEW."kind" = 'count_adjustment' AND NEW."source_type" = 'count' THEN
		SELECT EXISTS (
			SELECT 1
			FROM "count_session_locations" csl
			JOIN "count_sessions" s ON s."id" = csl."session_id"
			WHERE csl."session_id"::text = NEW."source_id"::text
			  AND csl."location_id" = NEW."location_id"
			  AND s."status" IN ('open','counting','reviewing')
		) INTO own_count;
		IF own_count THEN
			RETURN NEW;
		END IF;
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM "count_session_locations" csl
		JOIN "count_sessions" s ON s."id" = csl."session_id"
		WHERE csl."location_id" = NEW."location_id"
		  AND s."status" IN ('open','counting','reviewing')
	) INTO frozen;

	IF frozen THEN
		RAISE EXCEPTION 'location % is frozen by an active count session; finish or cancel the count first',
			NEW."location_id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
