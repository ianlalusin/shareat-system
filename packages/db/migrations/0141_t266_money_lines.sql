-- 0141 — T-266: supplier credit terms, and `expense_payments.cash_request_id` becomes a real FK.
-- docs/tasks/266-money-lines.md §4.4 and §5.
--
-- Two columns, one migration, because both exist to make the same form answerable.
--
-- 1. `suppliers.credit_terms_days` — NULL means cash-on-delivery, so the money form disables
--    *Credit (AP)* and names the supplier in the reason; a number means credit is accepted AND is
--    the default due date (`invoice_date + N days`). ONE nullable integer answers both "may we?"
--    and "due when?", which is why this is not a boolean beside a days column — those two can
--    disagree and nothing downstream could tell which was meant.
--
--    ⚠️ This models something v1 could not ask at all. Its `paymentOptions` is a comma-separated
--    free-text list written by one editor and read by one details page that prints it; no logic
--    anywhere consults it. Designed, not ported (bible §1.2d).
--
-- 2. `expense_payments.cash_request_id` text -> uuid, with a real FK to `cash_requests`.
--
--    ⛔ **This column stopped being metadata.** T-266 §4 found that an expense paid from a staff
--    float CANNOT POST: `1120` is seeded `requires_party = true` (one staff-float account per
--    store serves many holders, so the party is the only thing that decomposes it), but
--    `routeExpense` attached a party only for `1140`. The credit line went in party-less and
--    `journal_lines_party_requirement` (migration 0007) raised. This column is that party.
--
--    ⚠️ It was `text` under a comment reading "cash requests are not yet a table in this schema
--    (their own future task)". That stopped being true at `0034_t144_cash_requests.sql` and the
--    comment outlived it — a text column pointing at a uuid primary key, where a typo was
--    storable and nothing would object. Now that posting turns on it, it gets integrity.
--
--    ⚠️ The cast is `USING cash_request_id::uuid` and will RAISE on any value that is not a uuid,
--    which is deliberate: a malformed reference must stop the migration and be looked at, never
--    be silently nulled. Measured before writing this (2026-09-11): 1 row in shareat_dev and 0 in
--    shareat_test carry the column at all, and none is non-uuid. ⭐ Re-measure on production
--    before applying there — the same two counts, and the `!~ '^[0-9a-fA-F-]{36}$'` filter.
--
--    ⛔ `on delete restrict`, matching every other reference to `cash_requests`: a float that
--    funded a posted expense is part of that expense's audit trail and cannot be deleted out from
--    under it (the DEF-065 class of orphaned-leg problem).
--
-- No new tables, so no `rls/registry.ts` or `cutover/classification.ts` entry is required
-- (ADR-012 §5 step 4). Both tables already carry RLS and keep it unchanged.

ALTER TABLE "suppliers" ADD COLUMN "credit_terms_days" integer;--> statement-breakpoint

-- ⚠️ Nonsense terms are refused at the column rather than trusted from the form: a negative due
-- date is not a thing, and a five-year term is a typo for 365 with a stuck key. The upper bound is
-- generous on purpose — it is a typo guard, not a policy.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_credit_terms_days_check"
	CHECK ("suppliers"."credit_terms_days" IS NULL OR ("suppliers"."credit_terms_days" >= 0 AND "suppliers"."credit_terms_days" <= 365));--> statement-breakpoint

ALTER TABLE "expense_payments"
	ALTER COLUMN "cash_request_id" TYPE uuid USING "cash_request_id"::uuid;--> statement-breakpoint

ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_cash_request_id_fkey"
	FOREIGN KEY ("cash_request_id") REFERENCES "cash_requests"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- The float's own page asks "what did this request pay for?" — an index on the FK, matching the
-- shape `expense_payments_expense_id_idx` already uses for the other direction.
CREATE INDEX "expense_payments_cash_request_id_idx"
	ON "expense_payments" USING btree ("cash_request_id");
