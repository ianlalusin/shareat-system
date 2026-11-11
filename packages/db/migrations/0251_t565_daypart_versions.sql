-- 0251 -- T-565 (audit MC-002): menu_daypart_versions, the dated history of every daypart window. docs/tasks/565-daypart-versions.md s2.
-- Hand-authored per ADR-012 s5. Journal head when written: 0248; 0249 (T-557) and 0250 (T-564) are reserved and unmerged, so `when` is 0248 + 3 days and
-- the orchestrator fixes the ordering at merge time.
--
-- WHY. menu_dayparts (0233) is edited in place, and every reader judges by the CURRENT window. An order the tablet took offline under the old window was
-- refused ("pos: outside hours") or priced differently when it synced after a manager moved the window. Offers are already versioned by effective_from;
-- windows were not. This table makes a window a dated fact, so a reader can ask "which window was in force at this instant".
--
-- WHAT IT ADDS.
--   * menu_daypart_versions: id, org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from, valid_to (NULL = open). It copies the window
--     columns and CHECKs of menu_dayparts. Append-only: the only UPDATE is setting valid_to ONCE from NULL (trigger, ENABLE ALWAYS); no DELETE. At most one open
--     version per daypart (unique partial index). valid_to >= valid_from (zero length is legal: two edits in one transaction). A reader asks
--     valid_from <= at < coalesce(valid_to, infinity).
--   * Keys: (org_id, store_id) -> stores (same-org twin of the plain store FK), (store_id, daypart_id) -> menu_dayparts (store_id, id) (a daypart of another store
--     is refused; the org follows from the store). UNIQUE (store_id, id) is the target of the line key below. org_id is NOT NULL and RLS is the org backstop.
--   * Backfill (between the B0251 markers; idempotent): one OPEN version per existing daypart, valid_from = the daypart's created_at, copying its current
--     window and status. A RETIRED daypart gets an open version with status 'retired' (not a closed one): a reader at "now" then still finds the daypart exactly as
--     menu_dayparts says, and the window is the same before and after the retirement because no history of the earlier edits exists to restore. From here on
--     the writers (repo/dayparts.ts) keep it: create opens version 1; an edit closes the open version and opens the next; a retire does the same with status 'retired'.
--   * table_session_lines.daypart_version_id (nullable): the window version a dayparted offer was judged by when the line was written (NULL for an all-day offer
--     and for every line written before this migration). Composite key (store_id, daypart_version_id) -> menu_daypart_versions (store_id, id), MATCH SIMPLE so
--     NULL is free. Frozen from birth: table_session_lines_guard compares to_jsonb(NEW) with the three kitchen columns removed, and the UPDATE grant is not widened.
--     Receipt lines are untouched: they reach the session line through session_line_id.
--
-- RLS (0233 pattern): ENABLE + FORCE, one policy through app_current_org(), never raw current_setting (DEF-077).
-- GRANTS (ADR-012 s5 4a): shareat_app gets SELECT, INSERT and a column-level UPDATE (valid_to). No DELETE.
-- LOCK BUDGET. The new table is empty when created and the backfill reads menu_dayparts (a handful of rows per store). table_session_lines: ADD COLUMN nullable,
-- no default = catalogue change only; the FK is validated over rows that all hold NULL. First statement SET LOCAL lock_timeout = '5s'.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "menu_daypart_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"daypart_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days" smallint[] NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "menu_daypart_versions_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "menu_daypart_versions_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_daypart_versions_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "menu_daypart_versions_days_check" CHECK ("menu_daypart_days_ok"("days")),
	CONSTRAINT "menu_daypart_versions_end_not_start_check" CHECK ("end_time" <> "start_time"),
	CONSTRAINT "menu_daypart_versions_whole_minutes_check" CHECK (extract(second FROM "start_time") = 0 AND extract(second FROM "end_time") = 0),
	CONSTRAINT "menu_daypart_versions_within_day_check" CHECK ("start_time" < time '24:00' AND "end_time" < time '24:00'),
	CONSTRAINT "menu_daypart_versions_valid_range_check" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);
--> statement-breakpoint

ALTER TABLE "menu_daypart_versions" ADD CONSTRAINT "menu_daypart_versions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_daypart_versions" ADD CONSTRAINT "menu_daypart_versions_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_daypart_versions" ADD CONSTRAINT "menu_daypart_versions_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_daypart_versions" ADD CONSTRAINT "menu_daypart_versions_daypart_same_store_fk"
	FOREIGN KEY ("store_id","daypart_id") REFERENCES "menu_dayparts"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX "menu_daypart_versions_one_open_key" ON "menu_daypart_versions" ("daypart_id") WHERE "valid_to" IS NULL;
--> statement-breakpoint
CREATE INDEX "menu_daypart_versions_org_store_idx" ON "menu_daypart_versions" ("org_id","store_id");
--> statement-breakpoint

-- B0251:begin
INSERT INTO "menu_daypart_versions" ("org_id","store_id","daypart_id","name","days","start_time","end_time","status","valid_from")
SELECT d."org_id", d."store_id", d."id", d."name", d."days", d."start_time", d."end_time", d."status", d."created_at"
  FROM "menu_dayparts" d
 WHERE NOT EXISTS (SELECT 1 FROM "menu_daypart_versions" v WHERE v."daypart_id" = d."id");
--> statement-breakpoint
-- B0251:end

ALTER TABLE "menu_daypart_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "menu_daypart_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "menu_daypart_versions_org_isolation" ON "menu_daypart_versions"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

GRANT SELECT, INSERT ON "menu_daypart_versions" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("valid_to") ON "menu_daypart_versions" TO "shareat_app";
--> statement-breakpoint

CREATE FUNCTION "menu_daypart_versions_append_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'a daypart version is history and is never deleted (%)', OLD."id" USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD."valid_to" IS NOT NULL OR NEW."valid_to" IS NULL OR (to_jsonb(NEW) - 'valid_to') IS DISTINCT FROM (to_jsonb(OLD) - 'valid_to') THEN
		RAISE EXCEPTION 'a daypart version never changes; it is closed once, by setting valid_to (%)', OLD."id" USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "menu_daypart_versions_append_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "menu_daypart_versions_append_guard" BEFORE UPDATE OR DELETE ON "menu_daypart_versions"
	FOR EACH ROW EXECUTE FUNCTION "menu_daypart_versions_append_guard"();
--> statement-breakpoint
ALTER TABLE "menu_daypart_versions" ENABLE ALWAYS TRIGGER "menu_daypart_versions_append_guard";
--> statement-breakpoint

ALTER TABLE "table_session_lines" ADD COLUMN "daypart_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_daypart_version_same_store_fk"
	FOREIGN KEY ("store_id","daypart_version_id") REFERENCES "menu_daypart_versions"("store_id","id") ON DELETE RESTRICT;
