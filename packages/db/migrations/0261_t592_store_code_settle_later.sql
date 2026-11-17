-- 0261 - T-592: a store code belongs only on a settle-later channel, and a store has one active channel per platform. docs/tasks/592-sales-channels-store-code.md R1 + R2;
-- hand-authored per ADR-012 s5. Journal idx 261 follows 0260 (0258 was never used).
--
-- WHY. sales_channels.platform + platform_store_code (0228) is the ONE place a Foodpanda or Grab store code lives, and statement matching reads it. Nothing stopped a
-- code on a daily channel (dine-in reaches the till, no statement ever names it), and nothing stopped one store holding two active Foodpanda channels with two codes,
-- which is how "three codes in three places" could happen. The domain now refuses both with a sentence; this migration makes the database the authority.
--
-- WHAT IT ADDS.
--   * a pre-check (DO block): refuses the migration, naming counts and each offending row as <store code> / "<channel name>", if any channel already has a platform AND is remitted daily, or any store already
--     has two active channels on one platform. It NEVER moves, clears or chooses a code: a person decides which code is right.
--   * sales_channels_platform_only_settle_later_check: CHECK (platform IS NULL OR NOT is_remitted_daily), added NOT VALID then VALIDATEd.
--   * sales_channels_store_platform_active_key: UNIQUE (org_id, store_id, platform) WHERE platform IS NOT NULL AND is_active. A retired channel may keep its code and
--     platform (0228 keeps the org-wide code unique across active and retired), so reactivating one into a clash is refused by this index.
--
-- NO new table, so no classification or RLS registry entry. No data is changed.
--
-- LOCK BUDGET. sales_channels is tiny (a handful of rows per store). First statement SET LOCAL lock_timeout = '5s' (resets at commit). The CHECK is NOT VALID, then
-- VALIDATEd in its own statement; the index is a plain CREATE inside the migration transaction. Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
	coded_daily integer;
	coded_daily_rows text;
	doubled integer;
	doubled_rows text;
BEGIN
	SELECT count(*), string_agg(format('%s / "%s"', s.code, c.name), ', ' ORDER BY s.code, c.name) INTO coded_daily, coded_daily_rows
	  FROM sales_channels c JOIN stores s ON s.org_id = c.org_id AND s.id = c.store_id
	 WHERE c.platform IS NOT NULL AND c.is_remitted_daily;
	SELECT count(DISTINCT (c.org_id, c.store_id, c.platform)), string_agg(format('%s / "%s"', s.code, c.name), ', ' ORDER BY s.code, c.name) INTO doubled, doubled_rows
	  FROM sales_channels c JOIN stores s ON s.org_id = c.org_id AND s.id = c.store_id
	 WHERE c.platform IS NOT NULL AND c.is_active
	   AND (SELECT count(*) FROM sales_channels o WHERE o.org_id = c.org_id AND o.store_id = c.store_id AND o.platform = c.platform AND o.is_active) > 1;
	IF coded_daily > 0 OR doubled > 0 THEN
		-- BOSS ruling 17 Nov 2026: never move a code in SQL (it is ambiguous which settle-later card a code belongs on); a person moves it on screen.
		RAISE EXCEPTION '0261 refused: % channel(s) have a platform store code but are remitted daily (%); % store/platform pair(s) have two active channels (%). Move the code on screen first: on Settings > Sales channels, clear it on the daily channel and enter it on the right Foodpanda or Grab channel, then deploy again. Nothing was changed.',
			coded_daily, coalesce(coded_daily_rows, 'none'), doubled, coalesce(doubled_rows, 'none')
			USING ERRCODE = 'check_violation';
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_platform_only_settle_later_check" CHECK ("platform" IS NULL OR NOT "is_remitted_daily") NOT VALID;
--> statement-breakpoint
ALTER TABLE "sales_channels" VALIDATE CONSTRAINT "sales_channels_platform_only_settle_later_check";
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channels_store_platform_active_key" ON "sales_channels" ("org_id", "store_id", "platform") WHERE "platform" IS NOT NULL AND "is_active";
