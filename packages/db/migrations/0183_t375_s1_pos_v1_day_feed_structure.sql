-- 0183 - T-375 S1 (DEF-586, defect N1), docs/tasks/375-pos-v1-day-feed.md section S1, rulings R1, R2, R6.
--
-- STRUCTURE ONLY. Enforcement (the link-aware triggers on sales_days, sales_day_tenders and sales_day_channels)
-- is 0184 (S4); nothing here changes what an existing store may write, so every commit between S1 and S4 stays green.
--
--   pos_v1_store_links         one row per store linked to POS v1; its existence IS the per-store switch (I10).
--   pos_v1_day_feeds           the stored, immutable copy of one POS response (append-only).
--   tenders                    the store-scoped tender master (S2 fills it).
--   sales_day_pos_corrections  a manager's correcting entry after a POS change post-verify (S6 writes it; append-only).
--   sales_days                 + source, pos_v1_day_feed_id, refunds and their CHECKs.
--   pos_usage_pulls            + pos_v1_day_feed_id (the sold_items feed a pull is pinned to).
--
-- Grants (R1, ADR-012 section 5 step 4a): 0169 narrowed the default to SELECT + INSERT, and 0011:72 once granted
-- SELECT, INSERT, UPDATE, DELETE. This migration does not rely on whichever default the applying role holds: it
-- REVOKEs UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER from "shareat_app" on all four tables, then grants back
-- exactly UPDATE on links and tenders. Feeds and corrections end at SELECT + INSERT; no table has DELETE.
--
-- PRECHECK (production, read-only, before the push; bible row 278):
--   select count(*) from sales_days;
--   select store_id, status, count(*) from sales_days group by 1, 2;
--   select store_id, count(*) from sales_days where created_at > now() - interval '30 days' group by 1;
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE TABLE "pos_v1_store_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_store_id" text NOT NULL,
	"pos_store_name" text NOT NULL,
	"sales_channel_id" uuid NOT NULL,
	"pos_tax_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "pos_v1_store_links_store_id_unique" UNIQUE("store_id"),
	-- GLOBAL, not per org: two orgs linking one POS store would import the same sales twice (orchestrator ruling).
	CONSTRAINT "pos_v1_store_links_pos_store_id_unique" UNIQUE("pos_store_id"),
	CONSTRAINT "pos_v1_store_links_pos_tax_type_check" CHECK ("pos_tax_type" in ('vat_inclusive', 'vat_exclusive', 'non_vat')),
	CONSTRAINT "pos_v1_store_links_pos_store_id_not_blank_check" CHECK (btrim("pos_store_id") <> ''),
	CONSTRAINT "pos_v1_store_links_pos_store_name_not_blank_check" CHECK (btrim("pos_store_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "pos_v1_day_feeds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"pos_store_id" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_by" uuid NOT NULL,
	CONSTRAINT "pos_v1_day_feeds_batch_id_kind_unique" UNIQUE("batch_id", "kind"),
	CONSTRAINT "pos_v1_day_feeds_kind_check" CHECK ("kind" in ('sales', 'sold_items')),
	CONSTRAINT "pos_v1_day_feeds_purpose_check" CHECK ("purpose" in ('import', 'recheck', 'usage')),
	CONSTRAINT "pos_v1_day_feeds_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pos_v1_day_feeds_pos_store_id_not_blank_check" CHECK (btrim("pos_store_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "tenders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"money_account_id" uuid,
	"pos_v1_alias" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "tenders_kind_check" CHECK ("kind" in ('cash', 'wallet')),
	CONSTRAINT "tenders_wallet_account_shape_check" CHECK (("kind" = 'wallet') = ("money_account_id" is not null)),
	CONSTRAINT "tenders_name_not_blank_check" CHECK (btrim("name") <> ''),
	CONSTRAINT "tenders_pos_v1_alias_not_blank_check" CHECK ("pos_v1_alias" is null or btrim("pos_v1_alias") <> ''),
	-- An alias that normalizes to nothing ('--') would match every other such alias and no POS method.
	CONSTRAINT "tenders_pos_v1_alias_normalizes_check" CHECK ("pos_v1_alias" is null or regexp_replace(lower("pos_v1_alias"), '[^a-z0-9]', '', 'g') <> '')
);
--> statement-breakpoint
CREATE TABLE "sales_day_pos_corrections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"from_feed_id" uuid NOT NULL,
	"to_feed_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_day_pos_corrections_day_to_feed_unique" UNIQUE("sales_day_id", "to_feed_id"),
	CONSTRAINT "sales_day_pos_corrections_reason_not_blank_check" CHECK (btrim("reason") <> '')
);
--> statement-breakpoint

-- Foreign keys. Every one restrict: nothing here is ever deleted (no DELETE grant, I6).
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_sales_channel_id_sales_channels_id_fk" FOREIGN KEY ("sales_channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ADD CONSTRAINT "pos_v1_day_feeds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ADD CONSTRAINT "pos_v1_day_feeds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ADD CONSTRAINT "pos_v1_day_feeds_fetched_by_persons_id_fk" FOREIGN KEY ("fetched_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Composite, as 0171: the single-column money_accounts FK would accept another org's account (RLS only checks this
-- row's own org_id). MATCH SIMPLE: a cash tender's NULL account skips it.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "public"."money_accounts"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_sales_day_id_sales_days_id_fk" FOREIGN KEY ("sales_day_id") REFERENCES "public"."sales_days"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_from_feed_id_pos_v1_day_feeds_id_fk" FOREIGN KEY ("from_feed_id") REFERENCES "public"."pos_v1_day_feeds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_to_feed_id_pos_v1_day_feeds_id_fk" FOREIGN KEY ("to_feed_id") REFERENCES "public"."pos_v1_day_feeds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_posted_by_persons_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Indexes. Hand-added (expression / partial / ordered): schema/pos-v1.ts carries a NOTE beside each.
CREATE INDEX "pos_v1_day_feeds_store_day_kind_fetched_idx" ON "pos_v1_day_feeds" ("org_id", "store_id", "business_date", "kind", "fetched_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenders_store_name_unique" ON "tenders" ("store_id", lower(btrim("name")));
--> statement-breakpoint
-- R3: the normalized alias is the identity among a store's ACTIVE tenders (v1's normalization: lowercase, strip
-- everything but a-z and 0-9). 'G-Cash' and 'gcash' are one alias.
CREATE UNIQUE INDEX "tenders_store_alias_active_unique" ON "tenders" ("store_id", regexp_replace(lower("pos_v1_alias"), '[^a-z0-9]', '', 'g')) WHERE "is_active" and "pos_v1_alias" is not null;
--> statement-breakpoint
CREATE INDEX "tenders_org_store_idx" ON "tenders" ("org_id", "store_id");
--> statement-breakpoint
CREATE INDEX "pos_v1_store_links_org_idx" ON "pos_v1_store_links" ("org_id");
--> statement-breakpoint
CREATE INDEX "sales_day_pos_corrections_org_day_idx" ON "sales_day_pos_corrections" ("org_id", "sales_day_id");
--> statement-breakpoint

-- Existing tables.
ALTER TABLE "sales_days"
	ADD COLUMN "source" text DEFAULT 'legacy_typed' NOT NULL,
	ADD COLUMN "pos_v1_day_feed_id" uuid,
	ADD COLUMN "refunds" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_pos_v1_day_feed_id_pos_v1_day_feeds_id_fk" FOREIGN KEY ("pos_v1_day_feed_id") REFERENCES "public"."pos_v1_day_feeds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_source_check" CHECK ("source" in ('legacy_typed', 'pos_v1_day_feed'));
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_source_feed_id_check" CHECK (("source" = 'pos_v1_day_feed') = ("pos_v1_day_feed_id" is not null));
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_feed_source_pos_sourced_check" CHECK ("source" <> 'pos_v1_day_feed' or "pos_sourced");
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_refunds_only_on_feed_days_check" CHECK ("source" = 'pos_v1_day_feed' or "refunds" = 0);
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_refunds_non_negative_check" CHECK ("refunds" >= 0);
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_refunds_finite_check" CHECK ("refunds" > '-Infinity'::numeric and "refunds" < 'Infinity'::numeric);
--> statement-breakpoint
CREATE INDEX "sales_days_pos_v1_day_feed_id_idx" ON "sales_days" ("pos_v1_day_feed_id");
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD COLUMN "pos_v1_day_feed_id" uuid;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_pos_v1_day_feed_id_pos_v1_day_feeds_id_fk" FOREIGN KEY ("pos_v1_day_feed_id") REFERENCES "public"."pos_v1_day_feeds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Append-only (I6). One function per table so the refusal names it; precedent 0009 (etl_source_documents).
CREATE FUNCTION "pos_v1_day_feeds_check_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'pos_v1_day_feeds is append-only: % is not permitted. Each fetch is a fact; a POS change is a NEW feed row, never an edit (T-375, I6).', TG_OP
		USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "pos_v1_day_feeds_append_only"
	BEFORE UPDATE OR DELETE ON "pos_v1_day_feeds"
	FOR EACH ROW EXECUTE FUNCTION "pos_v1_day_feeds_check_append_only"();
--> statement-breakpoint
CREATE FUNCTION "sales_day_pos_corrections_check_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'sales_day_pos_corrections is append-only: % is not permitted. A wrong correction is itself corrected by a new row (T-375, I6).', TG_OP
		USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sales_day_pos_corrections_append_only"
	BEFORE UPDATE OR DELETE ON "sales_day_pos_corrections"
	FOR EACH ROW EXECUTE FUNCTION "sales_day_pos_corrections_check_append_only"();
--> statement-breakpoint

-- T-354 / DEF-487: immutability triggers are ENABLE ALWAYS, so session_replication_role = replica cannot switch them off.
ALTER TABLE "pos_v1_day_feeds" ENABLE ALWAYS TRIGGER "pos_v1_day_feeds_append_only";
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ENABLE ALWAYS TRIGGER "sales_day_pos_corrections_append_only";
--> statement-breakpoint

-- RLS: ENABLE and FORCE as the table is created, app_current_org() never a raw current_setting (DEF-077),
-- WITH CHECK as well as USING (DEF-183).
ALTER TABLE "pos_v1_store_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_v1_store_links_org_isolation" ON "pos_v1_store_links"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_v1_day_feeds_org_isolation" ON "pos_v1_day_feeds"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "tenders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenders_org_isolation" ON "tenders"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sales_day_pos_corrections_org_isolation" ON "sales_day_pos_corrections"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- Grants: exactly R1's set, whatever default privileges the applying role holds.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_v1_store_links", "pos_v1_day_feeds", "tenders", "sales_day_pos_corrections" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "pos_v1_store_links", "pos_v1_day_feeds", "tenders", "sales_day_pos_corrections" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ON "pos_v1_store_links" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ON "tenders" TO "shareat_app";
