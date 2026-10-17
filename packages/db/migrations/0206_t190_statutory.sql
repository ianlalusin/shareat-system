-- 0206 - T-190: payroll statutory contributions and withholding. Hand-authored per ADR-012 s5.
-- docs/tasks/190-payroll-statutory.md ("Schema", "Rates, lookups, refusals, immutability"); bible row 354 (start now), row 217.
-- 0204 (T-434) and 0205 (T-436) are reserved by other lanes: the gap at 204/205 is deliberate (ADR-012 s5 step 1).
--
-- WHAT. Three per-org reference tables (statutory_rates, withholding_brackets, minimum_wages), government numbers on persons, and the
-- statutory columns on payslips. payslips_net_identity_check is RESTATED: net = gross - sss_ee - philhealth_ee - pagibig_ee -
-- withholding - advance_recovered, and the advance may never exceed what is left after the four.
--
-- IMMUTABLE ROWS. A reference row is never edited: the app role holds UPDATE on (confirmed_at, confirmed_by) ONLY (ADR-012 s5 4a), and a
-- trigger refuses any other change (owner included) plus a second confirmation. A CONFIRMED row cannot be deleted; an unconfirmed,
-- never-used row can (a used contribution row is also held by the payslip FK, restrict). A correction is a NEW row with a later date.
--
-- SEED. The 2026 figures are seeded as DATA for the main organisation only (code = 'shareat'; none if it does not exist) (the main org; Padre Garcia gets none, row 305), every row
-- with confirmed_at NULL until the accountant confirms. minimum_wages is NOT seeded: each store's region and wage order are unknown
-- here, so a store's payroll POST refuses ("minimum wage") until the accountant adds and confirms its row.
--
-- No existing row is moved or deleted. New payslip money columns are NOT NULL DEFAULT 0, so the restated CHECK holds for every
-- payslip already stored (each new term is 0).

-- persons: government numbers (personal data; read only behind run_payroll / enrol_staff)
ALTER TABLE "persons" ADD COLUMN "sss_no" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "philhealth_no" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "pagibig_no" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "tin" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_sss_no_format_check" CHECK ("sss_no" IS NULL OR "sss_no" ~ '^[0-9]{10}$');
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_philhealth_no_format_check" CHECK ("philhealth_no" IS NULL OR "philhealth_no" ~ '^[0-9]{12}$');
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_pagibig_no_format_check" CHECK ("pagibig_no" IS NULL OR "pagibig_no" ~ '^[0-9]{12}$');
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_tin_format_check" CHECK ("tin" IS NULL OR "tin" ~ '^[0-9]{9,12}$');
--> statement-breakpoint

-- statutory_rates
CREATE TABLE "statutory_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"agency" text NOT NULL,
	"effective_from" date NOT NULL,
	"ee_rate" numeric(14, 4) NOT NULL,
	"er_rate" numeric(14, 4) NOT NULL,
	"base_kind" text NOT NULL,
	"floor" numeric(14, 2),
	"ceiling" numeric(14, 2),
	"step" numeric(14, 2),
	"low_threshold" numeric(14, 2),
	"low_ee_rate" numeric(14, 4),
	"ec_threshold" numeric(14, 2),
	"ec_low" numeric(14, 2),
	"ec_high" numeric(14, 2),
	"source_ref" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_rates_agency_check" CHECK ("agency" IN ('sss', 'philhealth', 'pagibig')),
	CONSTRAINT "statutory_rates_base_kind_check" CHECK ("base_kind" IN ('gross', 'basic')),
	CONSTRAINT "statutory_rates_effective_first_check" CHECK (EXTRACT(DAY FROM "effective_from") = 1),
	CONSTRAINT "statutory_rates_confirmed_pair_check" CHECK (("confirmed_at" IS NULL) = ("confirmed_by" IS NULL)),
	CONSTRAINT "statutory_rates_rates_check" CHECK ("ee_rate" >= 0 AND "ee_rate" <= 1 AND "er_rate" >= 0 AND "er_rate" <= 1 AND ("low_ee_rate" IS NULL OR ("low_ee_rate" >= 0 AND "low_ee_rate" <= 1))),
	CONSTRAINT "statutory_rates_amounts_check" CHECK (("floor" IS NULL OR "floor" >= 0) AND ("ceiling" IS NULL OR "ceiling" >= 0) AND ("step" IS NULL OR "step" > 0) AND ("low_threshold" IS NULL OR "low_threshold" >= 0) AND ("ec_threshold" IS NULL OR "ec_threshold" >= 0) AND ("ec_low" IS NULL OR "ec_low" >= 0) AND ("ec_high" IS NULL OR "ec_high" >= 0)),
	CONSTRAINT "statutory_rates_floor_ceiling_check" CHECK ("floor" IS NULL OR "ceiling" IS NULL OR "floor" <= "ceiling"),
	CONSTRAINT "statutory_rates_low_pair_check" CHECK (("low_threshold" IS NULL) = ("low_ee_rate" IS NULL)),
	CONSTRAINT "statutory_rates_ec_triple_check" CHECK (("ec_threshold" IS NULL) = ("ec_low" IS NULL) AND ("ec_threshold" IS NULL) = ("ec_high" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_confirmed_by_persons_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_confirmed_by_same_org_fk" FOREIGN KEY ("org_id", "confirmed_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_rates_org_agency_from_unique" ON "statutory_rates" ("org_id", "agency", "effective_from");
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_ee_rate_finite_check" CHECK ("ee_rate" > '-Infinity'::numeric AND "ee_rate" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_er_rate_finite_check" CHECK ("er_rate" > '-Infinity'::numeric AND "er_rate" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_floor_finite_check" CHECK ("floor" > '-Infinity'::numeric AND "floor" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_ceiling_finite_check" CHECK ("ceiling" > '-Infinity'::numeric AND "ceiling" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_step_finite_check" CHECK ("step" > '-Infinity'::numeric AND "step" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_low_threshold_finite_check" CHECK ("low_threshold" > '-Infinity'::numeric AND "low_threshold" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_low_ee_rate_finite_check" CHECK ("low_ee_rate" > '-Infinity'::numeric AND "low_ee_rate" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_ec_threshold_finite_check" CHECK ("ec_threshold" > '-Infinity'::numeric AND "ec_threshold" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_ec_low_finite_check" CHECK ("ec_low" > '-Infinity'::numeric AND "ec_low" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_ec_high_finite_check" CHECK ("ec_high" > '-Infinity'::numeric AND "ec_high" < 'Infinity'::numeric);
--> statement-breakpoint

-- withholding_brackets
CREATE TABLE "withholding_brackets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"effective_from" date NOT NULL,
	"over" numeric(14, 2) NOT NULL,
	"base_tax" numeric(14, 2) NOT NULL,
	"rate" numeric(14, 4) NOT NULL,
	"source_ref" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_brackets_frequency_check" CHECK ("frequency" IN ('monthly', 'semi_monthly', 'weekly')),
	CONSTRAINT "withholding_brackets_confirmed_pair_check" CHECK (("confirmed_at" IS NULL) = ("confirmed_by" IS NULL)),
	CONSTRAINT "withholding_brackets_amounts_check" CHECK ("over" >= 0 AND "over" < 'Infinity'::numeric AND "base_tax" >= 0 AND "base_tax" < 'Infinity'::numeric AND "rate" >= 0 AND "rate" <= 1)
);
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ADD CONSTRAINT "withholding_brackets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ADD CONSTRAINT "withholding_brackets_confirmed_by_persons_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ADD CONSTRAINT "withholding_brackets_confirmed_by_same_org_fk" FOREIGN KEY ("org_id", "confirmed_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "withholding_brackets_org_freq_from_over_unique" ON "withholding_brackets" ("org_id", "frequency", "effective_from", "over");
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ADD CONSTRAINT "withholding_brackets_over_finite_check" CHECK ("over" > '-Infinity'::numeric AND "over" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ADD CONSTRAINT "withholding_brackets_base_tax_finite_check" CHECK ("base_tax" > '-Infinity'::numeric AND "base_tax" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ADD CONSTRAINT "withholding_brackets_rate_finite_check" CHECK ("rate" > '-Infinity'::numeric AND "rate" < 'Infinity'::numeric);
--> statement-breakpoint

-- minimum_wages
CREATE TABLE "minimum_wages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"daily_rate" numeric(14, 2) NOT NULL,
	"wage_order_ref" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "minimum_wages_confirmed_pair_check" CHECK (("confirmed_at" IS NULL) = ("confirmed_by" IS NULL)),
	CONSTRAINT "minimum_wages_daily_rate_check" CHECK ("daily_rate" > 0 AND "daily_rate" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "minimum_wages" ADD CONSTRAINT "minimum_wages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "minimum_wages" ADD CONSTRAINT "minimum_wages_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "minimum_wages" ADD CONSTRAINT "minimum_wages_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "minimum_wages" ADD CONSTRAINT "minimum_wages_confirmed_by_persons_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "minimum_wages" ADD CONSTRAINT "minimum_wages_confirmed_by_same_org_fk" FOREIGN KEY ("org_id", "confirmed_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "minimum_wages_org_store_from_unique" ON "minimum_wages" ("org_id", "store_id", "effective_from");
--> statement-breakpoint
ALTER TABLE "minimum_wages" ADD CONSTRAINT "minimum_wages_daily_rate_finite_check" CHECK ("daily_rate" > '-Infinity'::numeric AND "daily_rate" < 'Infinity'::numeric);
--> statement-breakpoint

-- Immutability: nothing but the first confirmation changes; a confirmed row is never deleted.
CREATE FUNCTION t190_reference_row_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.confirmed_at IS NOT NULL THEN
			RAISE EXCEPTION '% row % is confirmed and cannot be deleted; add a new row with a later effective_from', TG_TABLE_NAME, OLD.id USING ERRCODE = '23000';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD.confirmed_at IS NOT NULL THEN
		RAISE EXCEPTION '% row % is already confirmed and cannot be changed or re-confirmed', TG_TABLE_NAME, OLD.id USING ERRCODE = '23000';
	END IF;
	IF (to_jsonb(NEW) - 'confirmed_at' - 'confirmed_by') IS DISTINCT FROM (to_jsonb(OLD) - 'confirmed_at' - 'confirmed_by') THEN
		RAISE EXCEPTION '% row % cannot be edited; only its first confirmation may be recorded', TG_TABLE_NAME, OLD.id USING ERRCODE = '23000';
	END IF;
	IF NEW.confirmed_at IS NULL THEN
		RAISE EXCEPTION '% row %: an update must set confirmed_at', TG_TABLE_NAME, OLD.id USING ERRCODE = '23000';
	END IF;
	RETURN NEW;
END $fn$;
--> statement-breakpoint
-- A confirmed bracket set is CLOSED: no row may be added to a (org, frequency, effective_from) set that already holds a confirmed row.
CREATE FUNCTION t190_bracket_set_closed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF EXISTS (SELECT 1 FROM withholding_brackets b WHERE b.org_id = NEW.org_id AND b.frequency = NEW.frequency
	           AND b.effective_from = NEW.effective_from AND b.confirmed_at IS NOT NULL) THEN
		RAISE EXCEPTION 'withholding_brackets set (% , %) is confirmed and closed; add a new set with a later effective_from', NEW.frequency, NEW.effective_from USING ERRCODE = '23000';
	END IF;
	RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER "withholding_brackets_set_closed" BEFORE INSERT ON "withholding_brackets" FOR EACH ROW EXECUTE FUNCTION t190_bracket_set_closed();
--> statement-breakpoint
CREATE TRIGGER "statutory_rates_immutable" BEFORE UPDATE OR DELETE ON "statutory_rates" FOR EACH ROW EXECUTE FUNCTION t190_reference_row_immutable();
--> statement-breakpoint
CREATE TRIGGER "withholding_brackets_immutable" BEFORE UPDATE OR DELETE ON "withholding_brackets" FOR EACH ROW EXECUTE FUNCTION t190_reference_row_immutable();
--> statement-breakpoint
CREATE TRIGGER "minimum_wages_immutable" BEFORE UPDATE OR DELETE ON "minimum_wages" FOR EACH ROW EXECUTE FUNCTION t190_reference_row_immutable();
--> statement-breakpoint
ALTER TABLE "statutory_rates" ENABLE ALWAYS TRIGGER "statutory_rates_immutable";
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ENABLE ALWAYS TRIGGER "withholding_brackets_immutable";
--> statement-breakpoint
ALTER TABLE "minimum_wages" ENABLE ALWAYS TRIGGER "minimum_wages_immutable";
--> statement-breakpoint

-- RLS (DEF-077 / DEF-183) and grants (ADR-012 s5 4/4a): UPDATE on the two confirmation columns only; DELETE for the unconfirmed-row delete.
ALTER TABLE "statutory_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "statutory_rates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "statutory_rates_org_isolation" ON "statutory_rates" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "withholding_brackets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "withholding_brackets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "withholding_brackets_org_isolation" ON "withholding_brackets" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "minimum_wages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "minimum_wages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "minimum_wages_org_isolation" ON "minimum_wages" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "statutory_rates", "withholding_brackets", "minimum_wages" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "statutory_rates", "withholding_brackets", "minimum_wages" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("confirmed_at", "confirmed_by") ON "statutory_rates", "withholding_brackets", "minimum_wages" TO "shareat_app";
--> statement-breakpoint

-- payslips: the statutory columns, then the restated identity.
ALTER TABLE "payslips" ADD COLUMN "sss_ee" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "philhealth_ee" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "pagibig_ee" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "withholding" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "sss_er" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "sss_ec" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "philhealth_er" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "pagibig_er" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "taxable_pay" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "is_mwe" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "skipped_agencies" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "sss_rate_id" uuid;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "philhealth_rate_id" uuid;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "pagibig_rate_id" uuid;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sss_rate_id_statutory_rates_id_fk" FOREIGN KEY ("sss_rate_id") REFERENCES "public"."statutory_rates"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_philhealth_rate_id_statutory_rates_id_fk" FOREIGN KEY ("philhealth_rate_id") REFERENCES "public"."statutory_rates"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pagibig_rate_id_statutory_rates_id_fk" FOREIGN KEY ("pagibig_rate_id") REFERENCES "public"."statutory_rates"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_rates" ADD CONSTRAINT "statutory_rates_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sss_rate_id_same_org_fk" FOREIGN KEY ("org_id", "sss_rate_id") REFERENCES "statutory_rates" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_philhealth_rate_id_same_org_fk" FOREIGN KEY ("org_id", "philhealth_rate_id") REFERENCES "statutory_rates" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pagibig_rate_id_same_org_fk" FOREIGN KEY ("org_id", "pagibig_rate_id") REFERENCES "statutory_rates" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "payslips_sss_rate_idx" ON "payslips" ("sss_rate_id") WHERE "sss_rate_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payslips_philhealth_rate_idx" ON "payslips" ("philhealth_rate_id") WHERE "philhealth_rate_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payslips_pagibig_rate_idx" ON "payslips" ("pagibig_rate_id") WHERE "pagibig_rate_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_skipped_agencies_check" CHECK ("skipped_agencies" <@ ARRAY['sss', 'philhealth', 'pagibig']::text[]);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_statutory_nonnegative_check" CHECK ("sss_ee" >= 0 AND "philhealth_ee" >= 0 AND "pagibig_ee" >= 0 AND "withholding" >= 0 AND "sss_er" >= 0 AND "sss_ec" >= 0 AND "philhealth_er" >= 0 AND "pagibig_er" >= 0 AND "taxable_pay" >= 0);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sss_ee_finite_check" CHECK ("sss_ee" > '-Infinity'::numeric AND "sss_ee" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_philhealth_ee_finite_check" CHECK ("philhealth_ee" > '-Infinity'::numeric AND "philhealth_ee" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pagibig_ee_finite_check" CHECK ("pagibig_ee" > '-Infinity'::numeric AND "pagibig_ee" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_withholding_finite_check" CHECK ("withholding" > '-Infinity'::numeric AND "withholding" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sss_er_finite_check" CHECK ("sss_er" > '-Infinity'::numeric AND "sss_er" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sss_ec_finite_check" CHECK ("sss_ec" > '-Infinity'::numeric AND "sss_ec" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_philhealth_er_finite_check" CHECK ("philhealth_er" > '-Infinity'::numeric AND "philhealth_er" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pagibig_er_finite_check" CHECK ("pagibig_er" > '-Infinity'::numeric AND "pagibig_er" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_taxable_pay_finite_check" CHECK ("taxable_pay" > '-Infinity'::numeric AND "taxable_pay" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_net_identity_check";
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_net_identity_check" CHECK ("net_pay" = "gross_pay" - "sss_ee" - "philhealth_ee" - "pagibig_ee" - "withholding" - "advance_recovered");
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_advance_within_gross_check";
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_advance_within_gross_check" CHECK ("advance_recovered" <= "gross_pay" - "sss_ee" - "philhealth_ee" - "pagibig_ee" - "withholding");
--> statement-breakpoint

-- Seed: the 2026 tables for the main organisation only (code = 'shareat'; none if it does not exist), every row UNCONFIRMED. The accountant confirms (or corrects) each "verify" row.
INSERT INTO "statutory_rates" ("org_id", "agency", "effective_from", "ee_rate", "er_rate", "base_kind", "floor", "ceiling", "step", "low_threshold", "low_ee_rate", "ec_threshold", "ec_low", "ec_high", "source_ref")
SELECT o.id, v.agency, DATE '2026-01-01', v.ee, v.er, v.base_kind, v.floor, v.ceiling, v.step, v.low_threshold, v.low_ee, v.ec_threshold, v.ec_low, v.ec_high, v.source_ref
FROM (SELECT id FROM organizations WHERE code = 'shareat') o
CROSS JOIN (VALUES
	('sss', 0.05::numeric, 0.10::numeric, 'gross', 5000::numeric, 35000::numeric, 500::numeric, NULL::numeric, NULL::numeric, 15000::numeric, 10::numeric, 30::numeric, 'SSS Circular 2024-006 (RA 11199 final step). VERIFY: no 2026 circular seen.'),
	('philhealth', 0.025::numeric, 0.025::numeric, 'basic', 10000::numeric, 100000::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 'RA 11223 s10; PhilHealth Circular 2020-0005. VERIFY the 2026 rate.'),
	('pagibig', 0.02::numeric, 0.02::numeric, 'basic', 0::numeric, 10000::numeric, NULL::numeric, 1500::numeric, 0.01::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 'HDMF Circular 460 (from Feb 2024). VERIFY basis (basic vs gross).')
) AS v(agency, ee, er, base_kind, floor, ceiling, step, low_threshold, low_ee, ec_threshold, ec_low, ec_high, source_ref);
--> statement-breakpoint
INSERT INTO "withholding_brackets" ("org_id", "frequency", "effective_from", "over", "base_tax", "rate", "source_ref")
SELECT o.id, v.frequency, DATE '2026-01-01', v."over", v.base_tax, v.rate, 'RR 11-2018 Annex E, 1 Jan 2023 onwards (TRAIN, RA 10963)'
FROM (SELECT id FROM organizations WHERE code = 'shareat') o
CROSS JOIN (VALUES
	('semi_monthly', 0::numeric, 0::numeric, 0::numeric),
	('semi_monthly', 10417::numeric, 0::numeric, 0.15::numeric),
	('semi_monthly', 16667::numeric, 937.50::numeric, 0.20::numeric),
	('semi_monthly', 33333::numeric, 4270.70::numeric, 0.25::numeric),
	('semi_monthly', 83333::numeric, 16770.70::numeric, 0.30::numeric),
	('semi_monthly', 333333::numeric, 91770.70::numeric, 0.35::numeric),
	('monthly', 0::numeric, 0::numeric, 0::numeric),
	('monthly', 20833::numeric, 0::numeric, 0.15::numeric),
	('monthly', 33333::numeric, 2500::numeric, 0.20::numeric),
	('monthly', 66667::numeric, 10833.33::numeric, 0.25::numeric),
	('monthly', 166667::numeric, 40833.33::numeric, 0.30::numeric),
	('monthly', 666667::numeric, 200833.33::numeric, 0.35::numeric),
	('weekly', 0::numeric, 0::numeric, 0::numeric),
	('weekly', 4808::numeric, 0::numeric, 0.15::numeric),
	('weekly', 7692::numeric, 432.60::numeric, 0.20::numeric),
	('weekly', 15385::numeric, 1971.20::numeric, 0.25::numeric),
	('weekly', 38462::numeric, 7740.45::numeric, 0.30::numeric),
	('weekly', 153846::numeric, 42355.65::numeric, 0.35::numeric)
) AS v(frequency, "over", base_tax, rate);
