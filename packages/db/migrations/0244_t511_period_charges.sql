-- 0244 - T-511 S6c: a platform charge with no sales day is booked once (channel_charge), and the payout that nets it settles it without expensing it twice.
-- docs/tasks/511-settlement-upload-s6c-spec.md Design A and C ("Tester findings and Opus rulings" 3 and 4 supersede); hand-authored per ADR-012 s5. Journal idx 244 (provisional, BOSS sets the final number at rebase time).
--
-- WHY. A weekly platform fee (and any uncategorised charge) carries no sales day, so the staged line is `period_charge`, `booked_as none`, and its VAT is lost. `postPlatformCharge`
-- books it once: Dr 6400 (fee + VAT) / Cr 1220 that channel, dated on the charge. When the platform nets the charge out of a later payout, the settlement says which charges it netted
-- so the receivable is credited once and the charge is never expensed a second time.
--
-- SHAPE.
--   settlement_other_lines.vat_amount          numeric(14,2) NULL, finite (NOT >= 0: a platform credit note has negative net and negative VAT). NULL = staged before S6c, refused for booking.
--   settlement_other_lines UNIQUE (org_id, id) the target of the same-org FK from channel_period_charges (trivially true, id alone is unique).
--   channel_period_charges                     one row per posted charge: id, org_id, store_id, channel_id, other_line_id, upload_id, charge_date, net/vat/total amount (signed, total = net + vat,
--                                              total <> 0), entry_date (where it posted), journal_entry_id, description, posted_by, posted_at. Unique (org, other_line) and (org, journal_entry).
--   channel_settlement_charge_links            (org_id, settlement_id, charge_id) primary key: which charges a payout netted. History only; a link counts only while its settlement
--                                              is not voided (read through the parent status, as the S6a legs). NO unique on the charge alone: a void frees the charge.
-- FOREIGN KEYS. Composite-only same-org twins (org_id, x) onto the (org_id, id) uniques, never a bare single-column FK (t398 C1); the charge's channel and store are ONE 3-column FK onto
-- sales_channels (org_id, id, store_id) (0228), so a charge never names another store than its channel's. All ON DELETE RESTRICT. MONEY numeric(14,2) with the t327 finite check.
-- RLS and GRANTS (ADR-012 s5 rules 4 and 4a). ENABLE + FORCE, policy <table>_org_isolation on app_current_org(); the app role gets SELECT and INSERT only.
-- APPEND-ONLY. A BEFORE UPDATE OR DELETE refuse trigger on each table, ENABLE ALWAYS (T-354 / DEF-487), house pattern 0243. No backfill: nothing posts before S7.
--
-- LOCK BUDGET. settlement_other_lines is a small table. First statement SET LOCAL lock_timeout = '5s' (resets at commit). Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- 1. settlement_other_lines: the staged VAT and the (org_id, id) unique
ALTER TABLE "settlement_other_lines" ADD COLUMN "vat_amount" numeric(14,2);
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD CONSTRAINT "settlement_other_lines_vat_amount_finite_check" CHECK ("vat_amount" > '-Infinity'::numeric AND "vat_amount" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD CONSTRAINT "settlement_other_lines_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint

-- 2. channel_period_charges
CREATE TABLE "channel_period_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"other_line_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"charge_date" date NOT NULL,
	"net_amount" numeric(14,2) NOT NULL,
	"vat_amount" numeric(14,2) NOT NULL,
	"total_amount" numeric(14,2) NOT NULL,
	"entry_date" date NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"description" text,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_period_charges_other_line_unique" UNIQUE ("org_id", "other_line_id"),
	CONSTRAINT "channel_period_charges_journal_entry_unique" UNIQUE ("org_id", "journal_entry_id"),
	CONSTRAINT "channel_period_charges_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "channel_period_charges_total_not_zero_check" CHECK ("total_amount" <> 0),
	CONSTRAINT "channel_period_charges_total_identity_check" CHECK ("total_amount" = "net_amount" + "vat_amount"),
	CONSTRAINT "channel_period_charges_net_amount_finite_check" CHECK ("net_amount" > '-Infinity'::numeric AND "net_amount" < 'Infinity'::numeric),
	CONSTRAINT "channel_period_charges_vat_amount_finite_check" CHECK ("vat_amount" > '-Infinity'::numeric AND "vat_amount" < 'Infinity'::numeric),
	CONSTRAINT "channel_period_charges_total_amount_finite_check" CHECK ("total_amount" > '-Infinity'::numeric AND "total_amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ADD CONSTRAINT "channel_period_charges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ADD CONSTRAINT "channel_period_charges_channel_store_same_org_fk" FOREIGN KEY ("org_id", "channel_id", "store_id") REFERENCES "public"."sales_channels"("org_id", "id", "store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ADD CONSTRAINT "channel_period_charges_other_line_id_same_org_fk" FOREIGN KEY ("org_id", "other_line_id") REFERENCES "public"."settlement_other_lines"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ADD CONSTRAINT "channel_period_charges_upload_id_same_org_fk" FOREIGN KEY ("org_id", "upload_id") REFERENCES "public"."settlement_uploads"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ADD CONSTRAINT "channel_period_charges_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "public"."journal_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ADD CONSTRAINT "channel_period_charges_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- 3. channel_settlement_charge_links
CREATE TABLE "channel_settlement_charge_links" (
	"org_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	CONSTRAINT "channel_settlement_charge_links_pkey" PRIMARY KEY ("org_id", "settlement_id", "charge_id")
);
--> statement-breakpoint
ALTER TABLE "channel_settlement_charge_links" ADD CONSTRAINT "channel_settlement_charge_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_settlement_charge_links" ADD CONSTRAINT "channel_settlement_charge_links_settlement_id_same_org_fk" FOREIGN KEY ("org_id", "settlement_id") REFERENCES "public"."channel_settlements"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_settlement_charge_links" ADD CONSTRAINT "channel_settlement_charge_links_charge_id_same_org_fk" FOREIGN KEY ("org_id", "charge_id") REFERENCES "public"."channel_period_charges"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "channel_settlement_charge_links_org_charge_idx" ON "channel_settlement_charge_links" ("org_id", "charge_id");
--> statement-breakpoint

-- 4. append-only, ENABLE ALWAYS (T-354 / DEF-487) so session_replication_role = replica cannot switch it off. The cutover purge uses TRUNCATE, which a row trigger does not see.
CREATE FUNCTION "channel_period_charges_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A period charge is never changed or removed (% on row % is refused). A wrong charge is reversed by hand in the books; its other line stays posted.',
		TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "channel_period_charges_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "channel_period_charges_append_only"
	BEFORE UPDATE OR DELETE ON "channel_period_charges"
	FOR EACH ROW EXECUTE FUNCTION "channel_period_charges_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "channel_period_charges" ENABLE ALWAYS TRIGGER "channel_period_charges_append_only";
--> statement-breakpoint
CREATE FUNCTION "channel_settlement_charge_links_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A settlement-charge link is never changed or removed (% on a link of settlement % is refused). A void of the settlement leaves it as history.',
		TG_OP, COALESCE(OLD.settlement_id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "channel_settlement_charge_links_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "channel_settlement_charge_links_append_only"
	BEFORE UPDATE OR DELETE ON "channel_settlement_charge_links"
	FOR EACH ROW EXECUTE FUNCTION "channel_settlement_charge_links_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "channel_settlement_charge_links" ENABLE ALWAYS TRIGGER "channel_settlement_charge_links_append_only";
--> statement-breakpoint

-- 5. RLS and grants
ALTER TABLE "channel_period_charges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "channel_period_charges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "channel_period_charges_org_isolation" ON "channel_period_charges" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "channel_period_charges" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "channel_period_charges" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "channel_settlement_charge_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "channel_settlement_charge_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "channel_settlement_charge_links_org_isolation" ON "channel_settlement_charge_links" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "channel_settlement_charge_links" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "channel_settlement_charge_links" TO "shareat_app";
