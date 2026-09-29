-- 0171 — T-357 / DEF-490, bible §13 row 244. Ian, 2026-09-29: "yes fix DEF-490 before launch".
-- docs/tasks/357-def-490-same-org-money-account-fk.md.
--
-- `sales_channels_destination_money_account_fk` (0057:36) is single-column: as `shareat_app` with
-- `app.org_id` = A, an INSERT/UPDATE that points an org-A channel at org B's money account is
-- ACCEPTED — RLS checks only the row's own org_id, and the FK check runs as the table owner and
-- never consults `money_accounts`' RLS. The only defence was the domain
-- (`setChannelPayoutDestination`'s org-scoped `getById`), one layer for one risk (§15.11).
--
-- R1 (measured, `shareat_test` at 0168): 547 FKs total. 360 run org-scoped table to org-scoped
-- table with no org_id in the key; 79 more run a derived-scope child to an org-scoped parent.
-- money_accounts is the target of 16 of them, plus 5 more from derived-scope children.
--
-- R2: of those 16, **11 join here** — every one whose child already carries its own `org_id NOT
-- NULL`: sales_channels.destination_money_account_id (nullable), channel_settlements
-- .destination_money_account_id, money_transfers.from_money_account_id,
-- money_transfers.to_money_account_id, cash_requests.released_from_money_account_id (nullable),
-- ap_payments.money_account_id, ar_collections.money_account_id, pay_runs.money_account_id,
-- thirteenth_month_runs.money_account_id, separations.money_account_id (nullable),
-- recurring_expenses.default_money_account_id (nullable). Each is cheap: one ADD CONSTRAINT, and
-- same-org holds by construction today, because every writer validates the account through an
-- org-scoped `getById`. The other **5** (expense_payments, remittance_lines ×2,
-- sales_day_tenders, till_count_lines) are DERIVED-scope children with no org_id column of their
-- own — out of scope; they need a column or a trigger first (a follow-up, DEF-491, Ian row 246).
--
-- R3 (shape, per 0159 step 8): `money_accounts` gets a new `UNIQUE (org_id, id)` — trivially true,
-- because `id` alone is already unique. Each of the 11 gets
-- `FOREIGN KEY (org_id, "<col>") REFERENCES money_accounts (org_id, id) ON DELETE RESTRICT`.
-- **MATCH SIMPLE** (the default, left unwritten, as 0159 did): when `<col>` is NULL, the composite
-- FK is skipped entirely, so the four nullable columns above still accept "no account chosen yet".
-- `org_id` is NOT NULL on all 11, so a non-NULL `<col>` is always checked. The OLD single-column
-- FKs are KEPT, unedited — dropping them buys nothing and every one of 157 differently-named FKs
-- (ADR-012 §3) would need re-verifying to confirm which is which.
--
-- R4: the first statement below is a DO-block PRE-FLIGHT, not a guard the ADD CONSTRAINTs need —
-- `ADD CONSTRAINT ... FOREIGN KEY` would 23503 on its own if a cross-org row existed. It exists
-- for the READABLE message: it counts, per one of the 11 FKs, child rows whose `<col>` is non-NULL
-- and whose money_accounts.org_id differs from the child's own org_id, and RAISEs naming every
-- non-zero one and its count if the total is > 0 — no UPDATE, no DELETE, no silent fix. This is
-- not blind the way T-354 R6's pre-flight was: the migrator bypasses RLS (`postgres` is a
-- superuser; `doadmin` is `rolbypassrls = t`, docs/ops/README.md:41), and even if it were blind,
-- the ADD CONSTRAINT statements after it validate as the owner with RLS off regardless.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired; it cannot emit a DO-block
-- pre-flight or a composite FK against a non-PK unique. Every statement is its own breakpoint,
-- except the last, which is the last statement in the file.

DO $$
DECLARE
	total integer := 0;
	n integer;
	bad_lines text[] := ARRAY[]::text[];
BEGIN
	SELECT count(*) INTO n FROM "sales_channels" t JOIN "money_accounts" m ON m."id" = t."destination_money_account_id" WHERE t."destination_money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('sales_channels.destination_money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "channel_settlements" t JOIN "money_accounts" m ON m."id" = t."destination_money_account_id" WHERE t."destination_money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('channel_settlements.destination_money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "money_transfers" t JOIN "money_accounts" m ON m."id" = t."from_money_account_id" WHERE t."from_money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('money_transfers.from_money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "money_transfers" t JOIN "money_accounts" m ON m."id" = t."to_money_account_id" WHERE t."to_money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('money_transfers.to_money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "cash_requests" t JOIN "money_accounts" m ON m."id" = t."released_from_money_account_id" WHERE t."released_from_money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('cash_requests.released_from_money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "ap_payments" t JOIN "money_accounts" m ON m."id" = t."money_account_id" WHERE t."money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('ap_payments.money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "ar_collections" t JOIN "money_accounts" m ON m."id" = t."money_account_id" WHERE t."money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('ar_collections.money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "pay_runs" t JOIN "money_accounts" m ON m."id" = t."money_account_id" WHERE t."money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('pay_runs.money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "thirteenth_month_runs" t JOIN "money_accounts" m ON m."id" = t."money_account_id" WHERE t."money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('thirteenth_month_runs.money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "separations" t JOIN "money_accounts" m ON m."id" = t."money_account_id" WHERE t."money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('separations.money_account_id: %s', n); END IF;

	SELECT count(*) INTO n FROM "recurring_expenses" t JOIN "money_accounts" m ON m."id" = t."default_money_account_id" WHERE t."default_money_account_id" IS NOT NULL AND t."org_id" <> m."org_id";
	total := total + n; IF n > 0 THEN bad_lines := bad_lines || format('recurring_expenses.default_money_account_id: %s', n); END IF;

	IF total > 0 THEN
		RAISE EXCEPTION
			'DEF-490: % cross-org money-account reference(s) found — %. No silent fix; each row needs a human decision.',
			total, array_to_string(bad_lines, ', ')
			USING ERRCODE = 'raise_exception';
	END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_destination_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "destination_money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_destination_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "destination_money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_from_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "from_money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_to_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "to_money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_released_from_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "released_from_money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_runs" ADD CONSTRAINT "thirteenth_month_runs_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_default_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "default_money_account_id") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;
