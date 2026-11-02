-- 0225 -- T-455 S9a: the lobby database role (the S3 "hard gate before S9"). docs/tasks/455-customer-lobby.md "S3 rulings" and "S9 rulings" item 1.
--
-- WHY. The diner routes in apps/customer (check-in, me, cancel, birthday, discount, store) are reachable by anyone with a phone. Until now they ran inside
-- `withOrgPrincipal`, i.e. as `shareat_app`, the org-wide application role: a bug or an injection in a diner route could read sales, persons and the books of the
-- whole organisation. They now run as `shareat_lobby`, which can touch ONLY what a diner route needs. The role has no login and no password (the 0011 pattern):
-- the session connects as the owner and then `set_config('role', 'shareat_lobby', true)` inside the transaction (packages/db/src/rls/principal.ts withLobbyPrincipal),
-- so the switch reverts at COMMIT or ROLLBACK and cannot outlive a request on a pooled connection.
--
-- WHAT IT MAY DO (pinned exactly by packages/db/tests/integration/t455-s9a-lobby-role.test.ts R2; add a table here and that test goes red until you say so):
--   lobby_stores              SELECT, and UPDATE (updated_at) only -- the check-in serialises on the store row with SELECT ... FOR UPDATE, which needs an UPDATE
--                             privilege on at least one column; the column grant keeps every switch (enabled, paused, max_live_entries, pos_seen_at) read-only
--   lobby_entries             SELECT, INSERT, UPDATE   (check-in, cancel)
--   lobby_entry_lines         SELECT, INSERT           (pre-order lines are written once)
--   lobby_entry_line_options  SELECT, INSERT
--   lobby_birthday_requests   SELECT, INSERT, UPDATE   (request, cancel)
--   lobby_discount_claims     SELECT, INSERT, UPDATE   (submit, cancel)
--   stores                    SELECT                   (the public store code -> id and the store name)
--   menu_item_variants        SELECT                   (a pre-order line names a variant; the check-in counts the ids)
--   menu_option_values        SELECT                   (the same for flavours)
-- Nothing else: no sales, no persons, no journal, no audit log, no DELETE or TRUNCATE anywhere, no function or sequence grant, no default privilege (so a table added
-- later is invisible to the lobby role until a migration grants it on purpose). Staff (POS terminal, cashier) paths stay on shareat_app and are unchanged.
--
-- RLS. The 0011 / 0215 policies carry no TO clause, so they apply to every role, this one included: `org_id = app_current_org()` for reads and `WITH CHECK` for
-- writes. The lobby role gets the org from `app.org_id` exactly as shareat_app does (the test pins both the filter and the check).
--
-- LOCK BUDGET (ADR-012 s5). Nothing is rewritten or scanned: one CREATE ROLE and GRANTs (catalog updates only). First statement SET LOCAL lock_timeout = '5s'
-- (resets at commit). GRANT takes a brief lock on each named table's catalog row, not on its data.
--
-- Membership: GRANT "shareat_lobby" TO "shareat_app" (last statement) so a production login that is a member of shareat_app can SET ROLE to the lobby role (audit blocker, 2 Nov).
-- Objects: no table, so no cutover classification and no RLS registry entry is added. The role is idempotent (a re-run on a database that has it changes nothing).
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shareat_lobby') THEN
		CREATE ROLE "shareat_lobby" NOLOGIN;
	END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO "shareat_lobby";
--> statement-breakpoint

GRANT SELECT ON "lobby_stores", "stores", "menu_item_variants", "menu_option_values" TO "shareat_lobby";
--> statement-breakpoint

GRANT UPDATE ("updated_at") ON "lobby_stores" TO "shareat_lobby";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "lobby_entries", "lobby_birthday_requests", "lobby_discount_claims" TO "shareat_lobby";
--> statement-breakpoint

GRANT SELECT, INSERT ON "lobby_entry_lines", "lobby_entry_line_options" TO "shareat_lobby";
--> statement-breakpoint

-- Production's application login (`shareat_app_prod`) is a member of `shareat_app` ONLY (docs/ops/README.md): it cannot SET ROLE to a role it is not a member of, so without this
-- line every diner route would answer "permission denied to set role". Granting the lobby role TO shareat_app means any login that can become shareat_app can also become
-- shareat_lobby (SET only, WITH INHERIT FALSE: PG16+ syntax; plain inherit would hand shareat_app the lobby SELECT on stores and defeat column revokes), while shareat_lobby itself stays a member of nothing (the direction matters: the reverse would hand the narrow role the wide one). Pinned by R1 and R4.
GRANT "shareat_lobby" TO "shareat_app" WITH INHERIT FALSE, SET TRUE;
