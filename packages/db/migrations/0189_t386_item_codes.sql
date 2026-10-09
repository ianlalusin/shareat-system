-- 0189 - T-386, docs/tasks/386-item-code-auto-suggest.md: item codes are suggested from the name (CHWN-001) and never issued twice.
--
-- PURPOSE: Ian 2026-10-09, "item code must be auto suggest based on the typed name fixed length ... this way we can control
-- duplication of code to avoid it". The domain assigns the code at creation (S3); this is the database's copy of the two rules
-- that make duplication impossible whatever the writer: (1) a code is unique IGNORING CASE, (2) a number once given out under a
-- 4-character stem is never given out again.
--
-- WHAT IT DOES:
--   1. items_org_code_key becomes UNIQUE (org_id, upper(code)) under the SAME name (errorMessage's regex and T-383 R4 keep working).
--   2. item_code_counters (org_id, stem, last_seq): the highest number ever issued per stem. RLS enabled and forced; the app role
--      may SELECT, INSERT, UPDATE; no DELETE. Seeded from every existing code already of the shape (P0189b, expected 0).
--   3. Trigger items_code_never_reused (BEFORE INSERT OR UPDATE OF code ON items, only for a code of the shape): the new number must
--      be ABOVE the stem's mark, and the mark rises to it. Legacy codes (PORK-BELLY) pass untouched until the S6 CHECK.
--      Origin mode: it reads another row's CURRENT state (the counters), so a restore must not re-run it.
--   4. Trigger item_code_counters_forward_only (BEFORE UPDATE): the mark never falls and the key never changes. ENABLE ALWAYS.
--
-- PRECHECKS (read-only, BEGIN READ ONLY; ... ROLLBACK;, run as doadmin with Ian before the push):
--   P0189a  SELECT org_id, status, count(*) FROM items GROUP BY 1, 2 ORDER BY 1, 2;          -- informational: what the recode touches
--   P0189b  SELECT count(*) FROM items WHERE code ~ '^[A-Z0-9]{4}-[0-9]{3}$';                 -- informational: already shaped, kept and seeded (expect 0)
--   P0189c  SELECT org_id, upper(code), count(*) FROM items GROUP BY 1, 2 HAVING count(*) > 1;
--           -- MUST be 0 rows: the new UNIQUE (org_id, upper(code)) cannot be built over a case-twin. If any, rename one
--           -- through Rename on the item page (T-383) before the push.
--   P0189d  SELECT count(*) FROM items WHERE code <> upper(code);                              -- informational: lower-case legacy codes
--   P0189e  SELECT count(*) FROM item_requests WHERE status = 'requested';                    -- informational: pending requests keep a typed code as their preview; approval allocates
--
-- THE SEED (between the B0189 markers) reads items, which is FORCE ROW LEVEL SECURITY: it runs with row_security off (the 0187/0188
-- pattern), so only a role RLS cannot filter (doadmin in production) can apply it; any other role fails LOUDLY (42501).
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

DROP INDEX "items_org_code_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_code_key" ON "items" USING btree ("org_id", upper("code"));
--> statement-breakpoint
CREATE TABLE "item_code_counters" (
	"org_id" uuid NOT NULL,
	"stem" text NOT NULL,
	"last_seq" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_code_counters_pkey" PRIMARY KEY("org_id", "stem"),
	CONSTRAINT "item_code_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
	CONSTRAINT "item_code_counters_stem_check" CHECK ("stem" ~ '^[A-Z0-9]{4}$'),
	CONSTRAINT "item_code_counters_last_seq_check" CHECK ("last_seq" BETWEEN 0 AND 999)
);
--> statement-breakpoint
ALTER TABLE "item_code_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_code_counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "item_code_counters_org_isolation" ON "item_code_counters"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
-- UPDATE: the trigger raises the mark and FOR UPDATE needs it (ADR-012 section 5 4a). No DELETE: a mark is never removed.
GRANT SELECT, INSERT, UPDATE ON "item_code_counters" TO "shareat_app";
--> statement-breakpoint
-- B0189:begin
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "item_code_counters" ("org_id", "stem", "last_seq")
SELECT "org_id", left("code", 4), max(right("code", 3)::int)
  FROM "items"
 WHERE "code" ~ '^[A-Z0-9]{4}-[0-9]{3}$'
 GROUP BY 1, 2;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0189:end
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "items_check_code_never_reused"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_stem text;
	v_seq integer;
	v_mark integer;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.code IS NOT DISTINCT FROM OLD.code THEN
		RETURN NEW;
	END IF;
	v_stem := left(NEW.code, 4);
	v_seq := right(NEW.code, 3)::integer;
	INSERT INTO item_code_counters (org_id, stem, last_seq) VALUES (NEW.org_id, v_stem, 0)
		ON CONFLICT (org_id, stem) DO NOTHING;
	SELECT c.last_seq INTO v_mark FROM item_code_counters c
	 WHERE c.org_id = NEW.org_id AND c.stem = v_stem FOR UPDATE;
	IF v_seq <= v_mark THEN
		RAISE EXCEPTION 'Item code % was already issued (high-water mark % for %) (T-386).', NEW.code, v_mark, v_stem
			USING ERRCODE = '23514', CONSTRAINT = 'items_code_never_reused';
	END IF;
	UPDATE item_code_counters SET last_seq = v_seq, updated_at = now()
	 WHERE org_id = NEW.org_id AND stem = v_stem;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "items_code_never_reused"
	BEFORE INSERT OR UPDATE OF "code" ON "items"
	FOR EACH ROW
	WHEN (NEW."code" ~ '^[A-Z0-9]{4}-[0-9]{3}$')
	EXECUTE FUNCTION "items_check_code_never_reused"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "item_code_counters_check_forward_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.stem IS DISTINCT FROM OLD.stem OR NEW.last_seq < OLD.last_seq THEN
		RAISE EXCEPTION 'An item-code mark only rises (T-386): % for % cannot become %.', OLD.last_seq, OLD.stem, NEW.last_seq
			USING ERRCODE = '23514', CONSTRAINT = 'item_code_counters_forward_only';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "item_code_counters_forward_only"
	BEFORE UPDATE ON "item_code_counters"
	FOR EACH ROW EXECUTE FUNCTION "item_code_counters_check_forward_only"();
--> statement-breakpoint
-- T-354 / DEF-487: the history guard is ENABLE ALWAYS, so session_replication_role = replica cannot switch it off.
ALTER TABLE "item_code_counters" ENABLE ALWAYS TRIGGER "item_code_counters_forward_only";
