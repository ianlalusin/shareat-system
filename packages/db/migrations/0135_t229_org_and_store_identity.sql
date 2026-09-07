-- T-229 slice 4 — organisation and store identity. **DEF-208.**
-- docs/tasks/229-reference-data-administration.md §4.1-4.8.
--
-- ⚠️ Hand-written from `schema/organizations.ts` and `schema/stores.ts`, per DEF-073 / DEF-121 —
-- `drizzle-kit generate`'s snapshot chain has been dead since 0019. Same convention as 0131-0134.
--
-- ⛔ **WHAT THIS FIXES IS A REPLATFORM LOSS, NOT A MISSING SCREEN.** v1 records `legalName`, `tin`,
-- `taxType` and a full address on every store (`admin/stores/store-editor.tsx:56-70`, section
-- "Identity & Tax"). v2 carried none of them across — `organizations` held id/name/code/is_active
-- and nothing else. A statutory identifier that exists in the live system today had nowhere to land.

-- ---------------------------------------------------------------------------------------------
-- 1. The ORGANISATION owns the registered identity.
--
-- ⭐ **Placement is CORRECTED, not copied.** v1 puts all of this on each store because v1 has no
-- organisation entity to put it on. In PH a corporation holds ONE TIN and each branch carries a
-- branch code against it, so duplicating the number onto seven store rows is seven places for it to
-- be wrong — the same failure discovery 23 §1 recorded for `taxType` duplicated across ERP and POS
-- ("the receipt the customer holds and the books disagree about VAT").
--
-- ⚠️ **EVERY COLUMN IS NULLABLE, AND THAT IS A DECISION.** Bible §13 row 75: this is a management
-- ledger, never a statutory filing basis, and nothing may be labelled BIR-ready. A NOT NULL `tin`
-- would assert the system cannot represent a business without one — the compliance posture row 75
-- disclaims — and would make an organisation un-creatable before somebody looks the number up,
-- inverting `bootstrap-org.ts`'s first step (the org must exist before the chart, the categories,
-- the first admin and the first store). 111 `insert into organizations` sites across the repo would
-- also break at once for a field none of them tests. `/settings/organization` insists instead, with
-- a banner naming what is unset and what it costs.
--
-- ⛔ NO BACKFILL, and none is possible: v1's values live in Firestore with no ETL path. The remedy
-- is a surface someone types the real values into. ⛔ **Do not seed a placeholder TIN** — a wrong
-- number that looks set is worse than an empty field that says it is empty.
ALTER TABLE "organizations" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tin" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tax_type" text;--> statement-breakpoint

-- ⛔ DESCRIPTIVE ONLY. There is no VAT engine in v2, so nothing computes tax from this column and
-- nothing may start to — the same posture T-230 took for `sales_channels.tax_treatment`. It exists
-- so a document can print the right registration. A future VAT feature is a task with its own spec.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tax_type_check"
	CHECK ("tax_type" IS NULL OR "tax_type" IN ('vat', 'non_vat'));--> statement-breakpoint

-- ⭐ A light FORMAT rule, and the reason it is light. A wrong number that LOOKS set is worse than an
-- empty field, and a TIN with a typo is exactly that case — so digits only, with the domain
-- stripping dashes and spaces first ("123-456-789" is accepted and stored "123456789").
-- ⛔ Deliberately NO checksum and NO cross-field rule against the branch code: a format check
-- catches a typo, a checksum starts to look like validating a registration, which is the compliance
-- posture this slice refuses. If a legitimate PH form is ever refused, WIDEN the pattern with the
-- source recorded — never drop the check.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tin_format_check"
	CHECK ("tin" IS NULL OR "tin" ~ '^[0-9]{9,12}$');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The STORE owns what is genuinely branch-level.
--
-- ⛔ NOT carried from v1: `logoPath` (not a books concern; nothing in v2 renders one) and the
-- `status` enum active/inactive/under_construction/closed — v2 has `is_active` plus T-222's DERIVED
-- readiness, and "under construction" is a readiness state, not a stored label somebody has to
-- remember to change (`stores/service.ts:219-230`).
-- ⚠️ ONE contact number, not v1's four (`email`, `phone`, `contactNo`, `telephone`).
ALTER TABLE "stores" ADD COLUMN "tin_branch_code" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "contact_number" text;--> statement-breakpoint

ALTER TABLE "stores" ADD CONSTRAINT "stores_tin_branch_code_format_check"
	CHECK ("tin_branch_code" IS NULL OR "tin_branch_code" ~ '^[0-9]{3,5}$');
