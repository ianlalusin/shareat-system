-- 0197 - T-402 S1a: the activity log's STORAGE. docs/tasks/402-activity-log.md (Rulings R1, R5-R7, R9, R10;
-- Contract section 3; Invariants 11-14). Ian, 2026-10-13: Q1-Q6 "go with recommendation".
--
-- WHAT. `audit_log` becomes a PARTITIONED table: PARTITION BY LIST (retention_class), each class
-- sub-partitioned BY RANGE (recorded_at) per Manila calendar year. It gains the R1 columns (store_id, category,
-- sensitivity, severity, retention_class, recorded_at, device_id, uploaded_by_person_id, event_key, redacted_keys,
-- clock_suspect), the R3/R4/R7 CHECKs, the same-org composite FKs (0194's pattern) and the two 0167 policies verbatim.
-- Two side tables come with it: audit_log_event_keys (R10, offline idempotency) and authz_denial_counts (R9).
--
-- WHY A REBUILD. A plain table cannot be converted to a partitioned one in place, and the primary key must now carry
-- both partition keys (id, retention_class, recorded_at). The old table is renamed, the new one built, every row is
-- copied with its label, and the old one dropped - all in this one transaction (drizzle applies every pending
-- migration in one). NOT reversible in place: the rollback is the restored-backup rehearsal before deploy (T-393
-- restore, apply this, compare per-action counts) and, on production, the pre-deploy backup.
--
-- THE COPY (step 3 of the contract). Every existing row gets category / sensitivity / severity / retention_class
-- from the VALUES list below (the 22 actions the 20 call sites write today; byte-identical strings, because
-- latestForEntity reads by action). The migration RAISEs if ANY existing row carries an action that is not in the
-- list (it never guesses a label) and RAISEs if the copied count differs from the source count. recorded_at =
-- occurred_at. store_id is backfilled from after->>'storeId' / before->>'storeId' ONLY when that store belongs to
-- the row's own org. `set_supplier_bank_account` rows are copied THROUGH THE R5 MASKING: bankAccountNumber keeps its
-- last 4 digits behind four bullets and `bankAccountNumberChanged` (true/false, computed from the UNMASKED pair) is
-- added to `after` (or to `before` when there is no `after`), so no full account number survives the copy.
-- TO CHECK AT REBASE TIME: the VALUES list must be rebuilt from production's DISTINCT action list the day this is
-- merged (any action deployed after the 22 must be added, or this RAISES by design).
--
-- ROW SECURITY. audit_log is FORCE RLS: a migrating role RLS can filter would read ZERO rows and the count check
-- would agree with itself. Production migrates as `doadmin`, which RLS cannot filter; `SET LOCAL row_security = off`
-- makes any OTHER role fail loudly instead (0166's pattern). It is set back to `on` at the end of this file, in the
-- same transaction, so it cannot leak into a later migration.
--
-- PARTITIONS (R6). A new partition inherits SELECT/INSERT for shareat_app from 0169's default privileges and has no
-- RLS of its own, so a query naming it would bypass the parent's policies. `audit_log_harden_partition()` does, for
-- every partition, REVOKE ALL FROM shareat_app, ENABLE + FORCE ROW LEVEL SECURITY with NO policy (deny-all if
-- reached directly) and ENABLE ALWAYS TRIGGER audit_log_append_only. `audit_log_create_year_partition(class, year)`
-- creates a Manila-year partition AND applies that recipe in one call: this migration uses it, and S5's maintenance
-- job (schema-owner connection) calls it. No DEFAULT partition, on purpose: a missing year fails loudly.
--
-- RETENTION (R7). The table CHECK `retention_class = 'r10y' OR (sensitivity = 'low' AND category NOT IN
-- ('money','order','menu_price','customer'))` means no writer bug can file money into the 2-year class.
--
-- device_id is a plain nullable uuid with NO FK (a device is a terminal, not a person; POS v2 adds the device table).
-- audit_log_event_keys pins each key to its log row with a composite FK;
-- S5 must delete an r2y year's keys BEFORE dropping that year's partition.
--
-- Every statement is its own breakpoint. HAND-WRITTEN, per ADR-012 section 5. Never edited after apply (RULES 1 rule 9).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

SET LOCAL row_security = off;
--> statement-breakpoint

-- Labels for the 22 existing actions. Retention and severity are derived below, never listed by hand.
CREATE TEMP TABLE t402_labels (action text PRIMARY KEY, category text NOT NULL, sensitivity text NOT NULL);
--> statement-breakpoint

INSERT INTO t402_labels (action, category, sensitivity) VALUES
	('reopen_pin_sign_in', 'security', 'high'),
	('set_supplier_credit_terms', 'money', 'normal'),
	('set_supplier_status', 'money', 'normal'),
	('set_supplier_bank_account', 'money', 'high'),
	('set_supplier_counterparty_store', 'money', 'normal'),
	('set_channel_payout', 'money', 'high'),
	('set_customer_status', 'customer', 'normal'),
	('change_item_base_unit', 'stock', 'normal'),
	('set_item_purchase_unit', 'stock', 'normal'),
	('rename_item', 'stock', 'normal'),
	('retire_item', 'stock', 'normal'),
	('restore_item', 'stock', 'normal'),
	('set_staff_code', 'staff', 'normal'),
	('link_store_to_pos', 'settings', 'normal'),
	('unlink_store_from_pos', 'settings', 'normal'),
	('create_tender', 'money', 'normal'),
	('update_tender', 'money', 'normal'),
	('reactivate_tender', 'money', 'normal'),
	('retire_tender', 'money', 'normal'),
	('edit_sales_day', 'money', 'high'),
	('reimport_sales_day', 'money', 'high'),
	('set_platform_sales', 'money', 'normal');
--> statement-breakpoint

-- Source facts, captured before anything moves. min_year is the minimum Manila year present (or the current one).
CREATE TEMP TABLE t402_src AS
SELECT count(*)::bigint AS n,
	LEAST(
		COALESCE(extract(year FROM min("occurred_at") AT TIME ZONE 'Asia/Manila')::int, extract(year FROM now() AT TIME ZONE 'Asia/Manila')::int),
		extract(year FROM now() AT TIME ZONE 'Asia/Manila')::int
	) AS min_year
FROM "audit_log";
--> statement-breakpoint

DO $$
DECLARE
	unlisted text;
BEGIN
	SELECT string_agg(DISTINCT a."action", ', ') INTO unlisted
	FROM "audit_log" a WHERE NOT EXISTS (SELECT 1 FROM t402_labels l WHERE l.action = a."action");
	IF unlisted IS NOT NULL THEN
		RAISE EXCEPTION 'T-402 0197: audit_log holds action(s) with no label: %. Add them to the VALUES list (rebuilt from production at rebase time); the migration never guesses a label.', unlisted;
	END IF;
END
$$;
--> statement-breakpoint

-- Park the old table and its index names so the new table can take the real ones.
ALTER TABLE "audit_log" RENAME TO "audit_log_t402_old";
--> statement-breakpoint

ALTER TABLE "audit_log_t402_old" RENAME CONSTRAINT "audit_log_pkey" TO "audit_log_t402_old_pkey";
--> statement-breakpoint

ALTER INDEX "audit_log_entity_entity_id_idx" RENAME TO "audit_log_t402_old_entity_idx";
--> statement-breakpoint

ALTER INDEX "audit_log_occurred_at_idx" RENAME TO "audit_log_t402_old_occurred_idx";
--> statement-breakpoint

ALTER INDEX "audit_log_org_occurred_at_idx" RENAME TO "audit_log_t402_old_org_occurred_idx";
--> statement-breakpoint

-- The partition recipe (R6). One function so the migration and S5's job cannot drift apart.
CREATE FUNCTION audit_log_harden_partition(p_rel regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
	EXECUTE format('REVOKE ALL ON %s FROM "shareat_app"', p_rel);
	EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_rel);
	EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_rel);
	EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER "audit_log_append_only"', p_rel);
END
$$;
--> statement-breakpoint

-- audit_log_<class>_<year>, bounds at 00:00 Asia/Manila (+08) so the year boundary is Manila's, never UTC's.
-- Idempotent: an existing partition is returned untouched. Needs the table owner (CREATE TABLE ... PARTITION OF).
CREATE FUNCTION audit_log_create_year_partition(p_class text, p_year integer) RETURNS regclass
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
	v_parent text;
	v_name text;
	v_rel regclass;
BEGIN
	IF p_class NOT IN ('r10y', 'r2y') THEN
		RAISE EXCEPTION 'audit_log_create_year_partition: unknown retention class %', p_class;
	END IF;
	IF p_year < 2000 OR p_year > 2200 THEN
		RAISE EXCEPTION 'audit_log_create_year_partition: implausible year %', p_year;
	END IF;
	v_parent := format('audit_log_%s', p_class);
	v_name := format('audit_log_%s_%s', p_class, p_year);
	v_rel := to_regclass(quote_ident(v_name));
	IF v_rel IS NOT NULL THEN
		RETURN v_rel;
	END IF;
	EXECUTE format(
		'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
		v_name, v_parent, format('%s-01-01 00:00:00+08', p_year), format('%s-01-01 00:00:00+08', p_year + 1)
	);
	v_rel := to_regclass(quote_ident(v_name));
	PERFORM audit_log_harden_partition(v_rel);
	RETURN v_rel;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION audit_log_harden_partition(regclass) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION audit_log_create_year_partition(text, integer) FROM PUBLIC;
--> statement-breakpoint

CREATE TABLE "audit_log" (
	"id" uuid NOT NULL DEFAULT uuidv7(),
	"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
	"store_id" uuid REFERENCES "stores"("id") ON DELETE RESTRICT,
	"actor_person_id" uuid REFERENCES "persons"("id") ON DELETE RESTRICT,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"sensitivity" text NOT NULL,
	"severity" smallint NOT NULL,
	"retention_class" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
	"recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
	"device_id" uuid,
	"uploaded_by_person_id" uuid REFERENCES "persons"("id") ON DELETE RESTRICT,
	"event_key" text,
	"redacted_keys" text[] NOT NULL DEFAULT '{}',
	"clock_suspect" boolean NOT NULL DEFAULT false,
	CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id", "retention_class", "recorded_at"),
	CONSTRAINT "audit_log_source_check" CHECK ("source" IN ('web', 'pos', 'customer', 'website', 'apk', 'kiosk', 'cron', 'ingestor', 'etl')),
	CONSTRAINT "audit_log_category_check" CHECK ("category" IN ('security', 'order', 'money', 'menu_price', 'stock', 'staff', 'settings', 'data', 'customer')),
	CONSTRAINT "audit_log_sensitivity_check" CHECK ("sensitivity" IN ('critical', 'high', 'normal', 'low')),
	CONSTRAINT "audit_log_severity_check" CHECK (("sensitivity", "severity") IN (('critical', 2), ('high', 4), ('normal', 5), ('low', 6))),
	CONSTRAINT "audit_log_retention_class_check" CHECK ("retention_class" IN ('r10y', 'r2y')),
	CONSTRAINT "audit_log_retention_by_sensitivity_check" CHECK ("retention_class" = 'r10y' OR ("sensitivity" = 'low' AND "category" NOT IN ('money', 'order', 'menu_price', 'customer')))
) PARTITION BY LIST ("retention_class");
--> statement-breakpoint

-- 0194's same-org twins (RLS checks only this row's org_id and the FK check runs as the owner).
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_uploaded_by_person_id_same_org_fk" FOREIGN KEY ("org_id", "uploaded_by_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint

-- Append-only (0167's function, unchanged). Created on the PARENT BEFORE the partitions so every partition clones it;
-- audit_log_harden_partition() then sets each clone to ENABLE ALWAYS (0168 / DEF-487).
CREATE TRIGGER "audit_log_append_only"
	BEFORE UPDATE OR DELETE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_mutation();
--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ALWAYS TRIGGER "audit_log_append_only";
--> statement-breakpoint

-- Class partitions (each itself partitioned by recorded_at), hardened like every other partition.
CREATE TABLE "audit_log_r10y" PARTITION OF "audit_log" FOR VALUES IN ('r10y') PARTITION BY RANGE ("recorded_at");
--> statement-breakpoint

CREATE TABLE "audit_log_r2y" PARTITION OF "audit_log" FOR VALUES IN ('r2y') PARTITION BY RANGE ("recorded_at");
--> statement-breakpoint

SELECT audit_log_harden_partition('audit_log_r10y'::regclass), audit_log_harden_partition('audit_log_r2y'::regclass);
--> statement-breakpoint

-- Years: the minimum Manila year present through the current year + 2, for both classes.
DO $$
DECLARE
	y integer;
	first_year integer;
	last_year integer;
	c text;
BEGIN
	SELECT min_year INTO first_year FROM t402_src;
	last_year := extract(year FROM now() AT TIME ZONE 'Asia/Manila')::int + 2;
	FOREACH c IN ARRAY ARRAY['r10y', 'r2y'] LOOP
		FOR y IN first_year..last_year LOOP
			PERFORM audit_log_create_year_partition(c, y);
		END LOOP;
	END LOOP;
END
$$;
--> statement-breakpoint

-- Bank-account masking for the copy (R5, Q6): last 4 digits behind four bullets (U+2022), plus the Changed flag.
CREATE FUNCTION t402_mask_bank(j jsonb, changed boolean, carry boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
	SELECT CASE WHEN j IS NULL OR jsonb_typeof(j) <> 'object' THEN j ELSE
		(CASE WHEN jsonb_typeof(j -> 'bankAccountNumber') = 'string'
			THEN jsonb_set(j, '{bankAccountNumber}', to_jsonb(
				repeat(chr(8226), 4) || (CASE WHEN length(j ->> 'bankAccountNumber') > 4 THEN right(j ->> 'bankAccountNumber', 4) ELSE '' END)))
			ELSE j END)
		|| (CASE WHEN carry THEN jsonb_build_object('bankAccountNumberChanged', changed) ELSE '{}'::jsonb END)
	END
$$;
--> statement-breakpoint

-- THE COPY. recorded_at = occurred_at; labels from t402_labels; severity and retention derived (R4, R7).
INSERT INTO "audit_log" ("id", "org_id", "store_id", "actor_person_id", "action", "entity", "entity_id", "before", "after", "source",
	"category", "sensitivity", "severity", "retention_class", "occurred_at", "recorded_at")
SELECT o."id", o."org_id",
	(SELECT s."id" FROM "stores" s
	 WHERE s."org_id" = o."org_id" AND s."id"::text IN (lower(o."after" ->> 'storeId'), lower(o."before" ->> 'storeId'))
	 ORDER BY (s."id"::text = lower(o."after" ->> 'storeId')) DESC LIMIT 1),
	o."actor_person_id", o."action", o."entity", o."entity_id",
	CASE WHEN o."action" = 'set_supplier_bank_account'
		THEN t402_mask_bank(o."before", (o."before" ->> 'bankAccountNumber') IS DISTINCT FROM (o."after" ->> 'bankAccountNumber'), jsonb_typeof(o."after") IS DISTINCT FROM 'object')
		ELSE o."before" END,
	CASE WHEN o."action" = 'set_supplier_bank_account'
		THEN t402_mask_bank(o."after", (o."before" ->> 'bankAccountNumber') IS DISTINCT FROM (o."after" ->> 'bankAccountNumber'), jsonb_typeof(o."after") = 'object')
		ELSE o."after" END,
	o."source", l.category, l.sensitivity,
	CASE l.sensitivity WHEN 'critical' THEN 2 WHEN 'high' THEN 4 WHEN 'normal' THEN 5 ELSE 6 END,
	CASE WHEN l.category IN ('money', 'order', 'menu_price', 'customer') OR l.sensitivity <> 'low' THEN 'r10y' ELSE 'r2y' END,
	o."occurred_at", o."occurred_at"
FROM "audit_log_t402_old" o JOIN t402_labels l ON l.action = o."action";
--> statement-breakpoint

DO $$
DECLARE
	copied bigint;
	expected bigint;
BEGIN
	SELECT count(*) INTO copied FROM "audit_log";
	SELECT n INTO expected FROM t402_src;
	IF copied IS DISTINCT FROM expected THEN
		RAISE EXCEPTION 'T-402 0197: count mismatch - copied % rows but the source held %. Nothing is committed.', copied, expected;
	END IF;
END
$$;
--> statement-breakpoint

DROP TABLE "audit_log_t402_old";
--> statement-breakpoint

DROP FUNCTION t402_mask_bank(jsonb, boolean, boolean);
--> statement-breakpoint

DROP TABLE t402_labels;
--> statement-breakpoint

DROP TABLE t402_src;
--> statement-breakpoint

-- RLS and the two policies, verbatim from 0167.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "audit_log_org_read" ON "audit_log" FOR SELECT
	USING ("org_id" = app_current_org());
--> statement-breakpoint

CREATE POLICY "audit_log_org_append" ON "audit_log" FOR INSERT
	WITH CHECK (
		"org_id" = app_current_org()
		AND (
			"actor_person_id" IS NULL
			OR EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "audit_log"."actor_person_id" AND p."org_id" = app_current_org())
		)
	);
--> statement-breakpoint

-- Grants: SELECT, INSERT on the PARENT only (0168/0170: no UPDATE, DELETE). Partitions were REVOKEd above.
REVOKE ALL ON "audit_log" FROM "shareat_app";
--> statement-breakpoint

GRANT SELECT, INSERT ON "audit_log" TO "shareat_app";
--> statement-breakpoint

-- Indexes on the parent (they propagate to every partition).
CREATE INDEX "audit_log_org_occurred_idx" ON "audit_log" ("org_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX "audit_log_org_store_occurred_idx" ON "audit_log" ("org_id", "store_id", "occurred_at" DESC);
--> statement-breakpoint

CREATE INDEX "audit_log_org_actor_occurred_idx" ON "audit_log" ("org_id", "actor_person_id", "occurred_at" DESC);
--> statement-breakpoint

CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log" ("entity", "entity_id");
--> statement-breakpoint

CREATE INDEX "audit_log_org_sensitive_idx" ON "audit_log" ("org_id", "occurred_at" DESC) WHERE "sensitivity" IN ('critical', 'high');
--> statement-breakpoint

CREATE INDEX "audit_log_org_clock_suspect_idx" ON "audit_log" ("org_id", "occurred_at") WHERE "clock_suspect";
--> statement-breakpoint

-- audit_log_event_keys (R10). A separate table because a UNIQUE on a partitioned table must include the partition keys.
CREATE TABLE "audit_log_event_keys" (
	"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
	"event_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"audit_log_id" uuid NOT NULL,
	"retention_class" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_log_event_keys_pkey" PRIMARY KEY ("org_id", "event_key"),
	CONSTRAINT "audit_log_event_keys_sha256_check" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_log_event_keys_retention_class_check" CHECK ("retention_class" IN ('r10y', 'r2y')),
	CONSTRAINT "audit_log_event_keys_audit_log_fk" FOREIGN KEY ("audit_log_id", "retention_class", "recorded_at") REFERENCES "audit_log" ("id", "retention_class", "recorded_at") ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX "audit_log_event_keys_retention_idx" ON "audit_log_event_keys" ("org_id", "retention_class", "recorded_at");
--> statement-breakpoint

CREATE INDEX "audit_log_event_keys_audit_log_idx" ON "audit_log_event_keys" ("audit_log_id", "retention_class", "recorded_at");
--> statement-breakpoint

ALTER TABLE "audit_log_event_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE "audit_log_event_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "audit_log_event_keys_org_read" ON "audit_log_event_keys" FOR SELECT USING ("org_id" = app_current_org());
--> statement-breakpoint

CREATE POLICY "audit_log_event_keys_org_append" ON "audit_log_event_keys" FOR INSERT WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

CREATE POLICY "audit_log_event_keys_org_delete" ON "audit_log_event_keys" FOR DELETE USING ("org_id" = app_current_org());
--> statement-breakpoint

REVOKE ALL ON "audit_log_event_keys" FROM "shareat_app";
--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON "audit_log_event_keys" TO "shareat_app";
--> statement-breakpoint

-- authz_denial_counts (R9): the hourly counters behind aggregated authorisation denials. NOT the log, NOT append-only.
-- store_id is NULL for an org-scoped capability, so the natural key is a UNIQUE ... NULLS NOT DISTINCT index
-- (the increment's ON CONFLICT target), with a surrogate primary key.
CREATE TABLE "authz_denial_counts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
	"actor_person_id" uuid NOT NULL REFERENCES "persons"("id") ON DELETE RESTRICT,
	"capability" text NOT NULL,
	"store_id" uuid REFERENCES "stores"("id") ON DELETE RESTRICT,
	"hour_bucket" timestamp with time zone NOT NULL,
	"count" integer NOT NULL DEFAULT 1,
	CONSTRAINT "authz_denial_counts_count_check" CHECK ("count" > 0),
	CONSTRAINT "authz_denial_counts_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "authz_denial_counts_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE UNIQUE INDEX "authz_denial_counts_key_idx" ON "authz_denial_counts" ("org_id", "actor_person_id", "capability", "store_id", "hour_bucket") NULLS NOT DISTINCT;
--> statement-breakpoint

CREATE INDEX "authz_denial_counts_bucket_idx" ON "authz_denial_counts" ("org_id", "hour_bucket");
--> statement-breakpoint

ALTER TABLE "authz_denial_counts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE "authz_denial_counts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "authz_denial_counts_org_read" ON "authz_denial_counts" FOR SELECT USING ("org_id" = app_current_org());
--> statement-breakpoint

CREATE POLICY "authz_denial_counts_org_append" ON "authz_denial_counts" FOR INSERT WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

CREATE POLICY "authz_denial_counts_org_update" ON "authz_denial_counts" FOR UPDATE USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

CREATE POLICY "authz_denial_counts_org_delete" ON "authz_denial_counts" FOR DELETE USING ("org_id" = app_current_org());
--> statement-breakpoint

REVOKE ALL ON "authz_denial_counts" FROM "shareat_app";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "authz_denial_counts" TO "shareat_app";
--> statement-breakpoint

-- Back to normal row security for whatever follows in the same transaction.
SET LOCAL row_security = on;
