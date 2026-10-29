# T-193 spec refresh: statutory payments, measured on main b3ace76 (2026-10-29)

**Status:** REFRESH by the Opus planner, 2026-10-29. Reads with `docs/tasks/193-statutory-remittance.md` (audited
2026-10-17, Q1-Q4 answered, bible row 365). Where the two disagree, **this file wins**. Branch `lane/t193-remittance`.
Lands after 0220 (T-398 S6) and 0221 (T-498 pay_rates append-only), both in open PRs today.
**Model:** Sonnet tester (red first, commits red), then Sonnet builder, per slice. Money, schema and auth: never Haiku.

---

## 1. What is still right (no change)

- **Goal, naming, model.** Tables `statutory_payments` / `statutory_payment_lines` / `statutory_employers`; source type
  `statutory_payment`; route `/payroll/statutory-payments`; domain file `payroll/statutory-payments.ts`; never the word
  "remittance" in code (it is the cashier's handover, `packages/domain/src/remittance/`). Grep 2026-10-29: none of
  these names exists yet anywhere in the tree.
- **Owed is derived, never stored.** Only `postPayRun` credits 2210-2240 today (`payroll/index.ts:744-747`); 13th month,
  separation and leave post none (grep of `STATUTORY_PAYABLE_ACCOUNT` / `WITHHOLDING_PAYABLE_ACCOUNT`, 2026-10-29).
  SSS = `sss_ee + sss_er + sss_ec`, PhilHealth = `philhealth_ee + philhealth_er`, Pag-IBIG = `pagibig_ee + pagibig_er`,
  BIR = `withholding` (exactly `payroll/index.ts:724-726, 747`). Month = calendar month of `pay_runs.period_end`
  (same rule as `statutoryRepo.monthToDate`, `repo/statutory.ts:378-393`). Posted runs only.
- **Bible row 365 answers** stand: one employer number per agency for the company; penalty estimate shown, real
  penalty booked when paid; penalty account **6810 Penalties and surcharges** (free today:
  `seed/chart-of-accounts.ts:396-402` jumps 6800 -> 6850); refuse `voidPayRun` while an agency payment for that month
  stands.
- **Orchestrator rulings 2026-10-17:** v2 payroll starts 1 Jan 2027 (first payment covers January 2027); an agency
  receipt / PRN is unique to one payment.
- **`RESERVED_LIABILITY_CODES`** still refuses 2210-2240 in the generic liability screen and already says "a statutory
  remittance settles it" (`packages/db/src/repo/liabilities.ts:23-36`). Unchanged.
- **Capability `remit_statutory`**, org scope, super_admin ✅ admin ✅ manager ✗ staff ✗; employer numbers edited under
  `manage_payroll_rates` (`capabilities.ts:594, 1015`). Personal data per row 353 (loader-gated CSV).
- **Out of scope list** unchanged (1601-E, official forms, catch-up of skipped months, loan deductions, credit carried
  forward, bank API).
- **Cases 1-21** stand as written, with the edits in §5 below.

## 2. Corrections, measured on main today

| # | Old spec said | Main today (file:line) | Now |
|---|---|---|---|
| C1 | Migration "0209 or next free" | Journal head is 0219 (`migrations/meta/_journal.json`, when 1804995107084). 0220 = T-398 S6 (`wt-t398-s6`), 0221 = T-498 (`wt-audit-t498s1`, when **1805167907084**) | **`0222_t193_statutory_payments.sql`**, journal `{ idx: 222, version: "7", when: 1805254307084, tag: "0222_t193_statutory_payments", breakpoints: true }`. If 0220/0221 change number before landing, renumber to head + 1, `when` = head.when + 86400000 |
| C2 | Idempotency key `statutory_payment:{id}:post` with a server-generated id; double submit caught only by the reference-no index | T-488 (bible row 401): every form-driven posting carries a **form-minted id** and replays through `postEntryOnce` (`ledger/replay.ts:17-25, 33-91`), which compares lines AND entry date. Document-id precedent: `money-transfers/settle.ts:64-71` (the form's uuid IS the document id) and `:113-130` (**replay looked up BEFORE the ceiling**) | The record form mints `paymentId = crypto.randomUUID()` per render (hidden input, as `money-transfers/page.tsx:85`). It becomes `statutory_payments.id`. Domain: `requireRequestId('recordStatutoryPayment', input.paymentId)`; key stays `statutory_payment:${paymentId}:post`; posts via **`postEntryOnce`**, never bare `postEntry`. Replay rules in §4.3 |
| C3 | "Period open/closed/locked is `postEntry`'s job; nothing re-checked here" | `postEntry` answers a closed month with developer text (`ledger/post-entry.ts:181, 196`). T-487 + T-492 S1 rule: check first with `periodRefusal(buildPeriodFacts(period), { override })` (`business-rules/expenses.ts:191, 200`), as `sales-days/verify.ts:152` and `expenses/approve.ts:361` | Before writing anything: `journalRepo.findPeriodForDate(tx, orgId, paid_on)`; no period -> refuse "There is no fiscal period for <date> yet."; else `periodRefusal(...)` -> `refuse(raw, sentence)`. **Closed + admin override**: pass `periodOverride` through to `postEntryOnce` (expense precedent; `remit_statutory` holders are admins, who hold `override_period_lock`). Locked: never. Screen reads it with `readPeriodOverride` / `periodOverrideProblem` / `closedMonthOf` (`apps/erp/src/lib/period-override.ts:39-67`), mirroring the expense approve form |
| C4 | Money leg party "`money_account` when 1140, as `payLiability`" | T-486 added the shared helpers `payrollMoneyParty(account)` (`payroll/index.ts:862-873`) and `assertPayrollMoneyAccount(account, fn)` (`:880-887`): 1140 carries party `money_account`; **1120 staff float refused by name** | Use both helpers (same module family, no copy). Refuse 1120 before any write. Picker omits 1120 (as `payroll/lib.ts` `cashAccountsFor` after T-486) |
| C5 | Cross-store pair hand-built; "party store = paying store" | Shared helper `withInterStoreLegs` (`ledger/inter-store.ts:52`) builds the 1250/2150 pair; **party id is the other store's CODE, not its uuid** (`:13`) | Call `withInterStoreLegs(tx, orgId, { owingStoreId: <money account's store>, lines, memo })`. With the PAYING store as `owingStoreId`, every line store with a net debit gets DR 1250 at the payer (party = line store code) / CR 2150 at the line store (party = payer code): exactly the documented shape, and correct for 3+ stores in one payment (passing a line store as `owingStoreId` mis-pairs the third store) |
| C6 | `journal_entry_id` "stays a plain FK (journal_entries has no (org_id, id) unique; same as payslips)" | `journal_entries_org_id_id_unique` exists since **0213:282** (T-398 S3), and 0213 gave payslips their twin (A11). The census `t398-s1-same-org-fk-census.test.ts` fails on any org->org FK without a twin | `journal_entry_id` gets a plain FK **and** `statutory_payments_journal_entry_id_same_org_fk` |
| C7 | POSTING-PATTERNS "line 1274" and "line 207" | `liability_payment.statutory-remittance` is now **1383-1401**; `reimbursement.payout-cross-store` is **212-229**; fixture `tests/worked-examples/fixtures.ts:1331` | Line numbers only. ⚠️ That fixture's `sourceType` is `liability_payment`; ours is `statutory_payment` on purpose: `reverseLiabilityEntry` accepts `liability_payment` entries (`liabilities/index.ts:249`), so reusing it would expose statutory entries to the generic liability reversal |
| C8 | ALWAYS trigger count "bump" | `t354-trigger-registry.test.ts:116` pins **35**; 0220 and 0221 each add one (36 in each lane) -> **37** when both land | T-193 makes it **38** (re-measure at build time: +1 over main) |
| C9 | Capability count bumps "in the three census tests" | `capability-matrix.test.ts:244, 321-323` pin 117 (118 after 0220's lane); `t337-capability-areas.test.ts:62-64, 148`; `access-defaults-lib.test.ts:119, 129` (106 rendered, 21 org) | +1 over main at build time (expected 119 / 107 / 22 org). Area `'staff'` like the other payroll capabilities (`capabilities.ts:786-787`) |
| C10 | Not mentioned | Chart count pinned at 102 in `packages/db/tests/integration/chart-of-accounts.test.ts:338, 341, 354, 584, 587, 594` | 6810 makes it **103 accounts / 96 leaves**; the tester bumps all six pins with a T-193 comment |
| C11 | Agency enum written ad hoc | `schema/statutory.ts:20` `STATUTORY_AGENCIES = ['sss','philhealth','pagibig']` (no BIR) is used by rate tables and `payslips_skipped_agencies_check` | Do NOT widen it. New `STATUTORY_PAYMENT_AGENCIES = ['sss','philhealth','pagibig','bir'] as const` beside it. GL map: `STATUTORY_PAYABLE_ACCOUNT` + `WITHHOLDING_PAYABLE_ACCOUNT` (`payroll/index.ts:57-58`), no renamed constants |
| C12 | Refusals as plain `throw new Error` | `tests/unit/t343-throw-ratchet.test.ts` ceilings raw throws per directory (`payroll/` included) | Every new refusal (and the `voidPayRun` guard) uses `refuse(raw, sentence)` (`@shareat/db` via `shared/refusal`). Zero new raw throws |
| C13 | Not mentioned | T-440 field rules: forms judge inputs with `assertFieldRules(RULES, …)` right after `authorize` (`liabilities/index.ts:178-181`, `field-rules/liabilities.ts:22`) | Add `PAYROLL_STATUTORY_PAYMENT_RULES`, `PAYROLL_STATUTORY_VOID_RULES`, `PAYROLL_STATUTORY_EMPLOYER_RULES` to `field-rules/payroll.ts` |
| C14 | `voidPayRun` "lock the run FOR UPDATE right after getPayRun" | Still true: `getPayRun` (`repo/payroll.ts:128-135`) does not lock; `voidPayRun` (`payroll/index.ts:809-853`) locks persons at `:827` | Unchanged design; add `payrollRepo.lockPayRun(tx, orgId, id)` (`.for('update')`, the `lockPersons` style at `repo/statutory.ts:401-410`), called right after `getPayRun`, then re-read status |
| C15 | Builder effort "about 3 days over 3 slices" | Added: replay, period override, field rules, two posting-pattern fixtures | **6 slices, about 6 builder days** (§5) |

T-492 (reversed headers frozen, 0219) and T-494 (AR outstanding) change nothing here: the void reverses through
`reverseEntry` (`ledger/reverse-entry.ts`), which already needs `reversalDate` when the original month is closed
(`:146-153`), and a reversed header is now immutable, which only strengthens case 20.

## 3. Migration 0222, exact contents

File `packages/db/migrations/0222_t193_statutory_payments.sql`. Header comment: task, this file, the WHY (pay the
agencies what payroll credited to 2210-2240; owed is derived from payslips, payments are stored), trigger classes,
and "journal head when written: 0219 (0220, 0221 in open PRs)". Every statement separated by
`--> statement-breakpoint`. Schema mirror in `packages/db/schema/statutory.ts` with `// NOTE: hand-added in migration
0222` beside the partial unique, the triggers and the RLS.

```sql
CREATE TABLE "statutory_employers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agency" text NOT NULL,
	"employer_no" text,
	"due_day" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "statutory_employers_agency_check" CHECK ("agency" IN ('sss', 'philhealth', 'pagibig', 'bir')),
	CONSTRAINT "statutory_employers_employer_no_check" CHECK (("agency" = 'bir') = ("employer_no" IS NULL) AND ("employer_no" IS NULL OR "employer_no" ~ '^[0-9]+$')),
	CONSTRAINT "statutory_employers_due_day_check" CHECK ("due_day" BETWEEN 1 AND 31),
	CONSTRAINT "statutory_employers_updated_pair_check" CHECK (("updated_by" IS NULL) = ("updated_at" IS NULL))
);
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_updated_by_same_org_fk" FOREIGN KEY ("org_id", "updated_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "statutory_employers_org_agency_unique" ON "statutory_employers" ("org_id", "agency");

CREATE TABLE "statutory_payments" (
	"id" uuid PRIMARY KEY NOT NULL,                       -- the form-minted paymentId (C2); no default on purpose
	"org_id" uuid NOT NULL,
	"agency" text NOT NULL,
	"month" date NOT NULL,
	"paid_on" date NOT NULL,
	"money_account_id" uuid NOT NULL,
	"reference_no" text NOT NULL,
	"penalty" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"journal_entry_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_payments_agency_check" CHECK ("agency" IN ('sss', 'philhealth', 'pagibig', 'bir')),
	CONSTRAINT "statutory_payments_month_first_check" CHECK (extract(day FROM "month") = 1),
	CONSTRAINT "statutory_payments_paid_on_check" CHECK ("paid_on" >= "month"),
	CONSTRAINT "statutory_payments_reference_no_check" CHECK ("reference_no" = btrim("reference_no") AND "reference_no" <> ''),
	CONSTRAINT "statutory_payments_penalty_check" CHECK ("penalty" >= 0 AND "penalty" < 'Infinity'::numeric),
	CONSTRAINT "statutory_payments_status_check" CHECK (
		("status" = 'posted' AND "void_reason" IS NULL AND "voided_by" IS NULL AND "voided_at" IS NULL)
		OR ("status" = 'voided' AND "void_reason" IS NOT NULL AND btrim("void_reason") <> '' AND "voided_by" IS NOT NULL AND "voided_at" IS NOT NULL))
);
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_org_id_id_unique" UNIQUE ("org_id", "id");
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_money_account_id_money_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "public"."money_accounts"("org_id", "id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "public"."journal_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "statutory_payments_posted_reference_unique" ON "statutory_payments" ("org_id", "agency", "reference_no") WHERE "status" = 'posted';
CREATE INDEX "statutory_payments_org_agency_month_idx" ON "statutory_payments" ("org_id", "agency", "month");

CREATE TABLE "statutory_payment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_payment_lines_amount_check" CHECK ("amount" > 0 AND "amount" < 'Infinity'::numeric)
);
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_payment_id_statutory_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."statutory_payments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_payment_id_same_org_fk" FOREIGN KEY ("org_id", "payment_id") REFERENCES "public"."statutory_payments"("org_id", "id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "statutory_payment_lines_payment_store_unique" ON "statutory_payment_lines" ("payment_id", "store_id");
CREATE INDEX "statutory_payment_lines_org_store_idx" ON "statutory_payment_lines" ("org_id", "store_id");

-- RLS: ENABLE + FORCE + one org_isolation policy each, the 0206 statutory_rates shape.
ALTER TABLE "statutory_employers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "statutory_employers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "statutory_employers_org_isolation" ON "statutory_employers" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
ALTER TABLE "statutory_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "statutory_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "statutory_payments_org_isolation" ON "statutory_payments" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
ALTER TABLE "statutory_payment_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "statutory_payment_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "statutory_payment_lines_org_isolation" ON "statutory_payment_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

-- Grants (ADR-012 s5 4a): born SELECT + INSERT; only the void columns and the one-time entry link are updatable.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "statutory_employers", "statutory_payments", "statutory_payment_lines" FROM "shareat_app";
GRANT SELECT, INSERT ON "statutory_employers", "statutory_payments", "statutory_payment_lines" TO "shareat_app";
GRANT UPDATE ("journal_entry_id", "status", "void_reason", "voided_by", "voided_at") ON "statutory_payments" TO "shareat_app";
GRANT UPDATE ("employer_no", "due_day", "updated_by", "updated_at") ON "statutory_employers" TO "shareat_app";

-- History guard (history_guard / ENABLE ALWAYS): decides only from OLD and NEW of the same row.
CREATE FUNCTION "statutory_payments_guard_history"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'statutory payment % cannot be deleted', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF OLD.status = 'voided' THEN
		RAISE EXCEPTION 'voided statutory payment % is final', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF NEW.status NOT IN ('posted', 'voided') THEN
		RAISE EXCEPTION 'statutory payment % may only stay posted or become voided', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
		RAISE EXCEPTION 'statutory payment % keeps its journal entry once set', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF (to_jsonb(NEW) - 'journal_entry_id' - 'status' - 'void_reason' - 'voided_by' - 'voided_at')
	   IS DISTINCT FROM (to_jsonb(OLD) - 'journal_entry_id' - 'status' - 'void_reason' - 'voided_by' - 'voided_at') THEN
		RAISE EXCEPTION 'statutory payment % is immutable except its void and its one journal link', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION "statutory_payments_guard_history"() FROM PUBLIC;
CREATE TRIGGER "statutory_payments_history_guard" BEFORE UPDATE OR DELETE ON "statutory_payments"
	FOR EACH ROW EXECUTE FUNCTION "statutory_payments_guard_history"();
ALTER TABLE "statutory_payments" ENABLE ALWAYS TRIGGER "statutory_payments_history_guard";

-- Line freeze (validator / origin, R1): reads the PARENT row's current state.
CREATE FUNCTION "statutory_payment_lines_check_parent_open"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE p record;
BEGIN
	SELECT journal_entry_id, status INTO p FROM statutory_payments WHERE id = NEW.payment_id AND org_id = NEW.org_id;
	IF p.journal_entry_id IS NOT NULL OR p.status <> 'posted' THEN
		RAISE EXCEPTION 'statutory payment % is already posted or voided; its lines are final', NEW.payment_id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payment_lines_parent_open';
	END IF;
	RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION "statutory_payment_lines_check_parent_open"() FROM PUBLIC;
CREATE TRIGGER "statutory_payment_lines_parent_open_trg" BEFORE INSERT ON "statutory_payment_lines"
	FOR EACH ROW EXECUTE FUNCTION "statutory_payment_lines_check_parent_open"();

-- 6810 Penalties and surcharges (bible row 365 Q3) for every existing org; the 0065 shape.
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '6810', 'Penalties and surcharges', 'expense', 'debit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '6000'
  AND NOT EXISTS (SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '6810');
```

(Breakpoints omitted above for reading; the file has one after every statement.) Also in S1: `leaf('6810',
'Penalties and surcharges', 'expense', 'debit', '6000')` in `seed/chart-of-accounts.ts` between 6800 and 6850;
`TRIGGER_REGISTRY` entries `statutory_payments_history_guard` (`always`, `history_guard`) and
`statutory_payment_lines_parent_open_trg` (`origin`, `validator`); RLS registry `org_column` x3; classification:
payments + lines **`purge`**, employers **`keep`** (reasons as the old spec).

## 4. Posting legs (looked up)

Source type `statutory_payment`, sourceId = payment id, key `statutory_payment:${paymentId}:post`, entryDate = `paid_on`,
via `postEntryOnce`. One entry per payment.

| Leg | Account | Store | Dr / Cr | Party | Looked up in |
|---|---|---|---|---|---|
| per line | 2210 / 2220 / 2230 / 2240 by agency | the line's store | Dr line amount | none (0040: statutory payables party-free) | POSTING-PATTERNS 1383-1401 `liability_payment.statutory-remittance` |
| per line at another store | 2150 Due to related store | the line's store | Cr | `store`, the PAYER's code | 212-229 `reimbursement.payout-cross-store` ("an ap_payment drawn on another store's account has exactly the same shape"); built by `withInterStoreLegs` |
| same | 1250 Due from related store | the paying store | Dr | `store`, the line store's code | same |
| penalty > 0 | 6810 Penalties and surcharges | the paying store | Dr penalty | none | 143-159 `expense.cash.simple` (shape only); account per row 365 Q3 |
| cash out | the money account's GL code (1110/1130/1140...) | the money account's store | Cr Σ lines + penalty | `money_account` iff 1140 (`payrollMoneyParty`); 1120 refused | 1383-1401; T-486 helpers |

⛔ No leg ever touches 6100-6130 (§16.7 double count). A penalty never goes into 22x0.
**Gap (see §7):** POSTING-PATTERNS documents only the same-store, no-penalty shape for statutory remittance. The
cross-store and penalty variants are composed from two documented patterns; neither has its own worked example.

### 4.1 `recordStatutoryPayment(tx, actor, input)`, one transaction, in this order
1. `authorize(actor, 'remit_statutory', { orgId })`; `assertFieldRules(PAYROLL_STATUTORY_PAYMENT_RULES, …)`;
   `requireRequestId('recordStatutoryPayment', input.paymentId)`.
2. Employer number on file (`statutory_employers`) for sss/philhealth/pagibig, `organizations.tin` for bir; else refuse
   naming it.
3. `month` is the 1st and not after the current Manila month (`toBusinessDate()`, `packages/core/src/datetime.ts:38`).
   Every amount through `parseMoneyInput` (`shared/money-input.ts:155`), summed with core money.
4. Money account: exists in org; `assertPayrollMoneyAccount(account, 'recordStatutoryPayment')`.
5. Period pre-check (C3).
6. Lock the month's posted `pay_runs` of the named stores FOR UPDATE in id order (new
   `statutoryPaymentsRepo.lockMonthRuns`), so a run voided while waiting drops out.
7. **Replay check, BEFORE the ceiling** (settle precedent): `getById(org, paymentId)`. Exists and voided -> refuse
   "This payment was voided. Reload the page and start a new one." Exists posted -> compare agency, month, paid_on,
   money account, reference_no, penalty and the set of (store, amount) lines; same -> return the stored result
   (`created: false`); different -> refuse "This was already recorded with different figures. Reload the page and try
   again." Not found -> continue.
8. Read owed and paid (later statements, READ COMMITTED). Each line ≤ its store's outstanding; a store with 0 owed is
   refused; overpaying refused naming store and figure.
9. `checkDraw(tx, orgId, account, Σ lines + penalty, 'recordStatutoryPayment')`.
10. Insert payment (`INSERT … ON CONFLICT (id) DO NOTHING RETURNING id`; no row -> go back to step 7's comparison,
    which then refuses or replays) and lines; build legs; `withInterStoreLegs`; `postEntryOnce` (with `periodOverride`
    when given); set `journal_entry_id`; audit row.

### 4.2 `voidStatutoryPayment` and the `voidPayRun` guard
As the old spec (lock payment FOR UPDATE, posted only, reverse ONLY its own `journal_entry_id` with `reversalDate`
only when `on` is given, conditional UPDATE `WHERE status = 'posted'`, audit). `voidPayRun`: `lockPayRun` right after
`getPayRun`, re-read status, then the guard (refuse via `refuse`, naming the payment's reference no.).

## 5. Slices (each ≤ 1 builder day; tester commits red first, then builder)

Test files: `packages/db/tests/integration/t193-statutory-payments-schema.test.ts`,
`packages/domain/tests/integration/t193-statutory-payments.test.ts`, `apps/erp/tests/t193-statutory-payments-lib.test.ts`.
Real Postgres, a dedicated fresh `*_test` DB, fresh ids, never a lane-DB name. Fixtures reuse
`_fixtures/statutory-rates.ts`. Case numbers = the old spec's; R/P/K = new.

**S1 Schema (0222).** Migration, schema file + `STATUTORY_PAYMENT_AGENCIES`, journal, RLS registry, classification,
trigger registry, 6810 seed, `docs/GLOSSARY.md` row (**statutory payment** ≠ **remittance**). Pins: t354 ALWAYS +1,
chart 102->103 (six pins). *Done when:* migration applies from zero on a scratch DB; legs below green; census, RLS,
classification, same-org FK census, trigger registry, journal guards green.
- Case 17 (UPDATE amount/reference_no/penalty refused, DELETE refused, un-void refused, padded/empty reference refused,
  bir employer_no refused). *Kills:* GRANT UPDATE on all columns; missing btrim CHECK.
- Case 21 DB legs (line INSERT after `journal_entry_id` set refused; `journal_entry_id` change refused; un-void refused
  under `session_replication_role = replica`; posted reference reuse refused, reuse after void allowed). *Kills:*
  trigger left `origin`; no line freeze; non-partial unique.
- Case 18 FK leg (line naming another org's store / money account / journal entry refused). *Kills:* FK on
  `store_id` alone; journal_entry_id without twin.
- Case 15 DB leg (month not the 1st; `paid_on` before month). *Kills:* missing CHECK.
- K1: 6810 exists for an org created before 0222 and for a freshly seeded org. *Kills:* seed-only (old orgs lack it).

**S2 Repo + derivation.** `packages/db/src/repo/statutory-payments.ts` (owed per org/agency/month/store from posted
payslips, paid from posted lines, per-person month detail, all-time outstanding vs GL per store/agency,
`lockMonthRuns`, `getById`, inserts, `setEntry`, `markVoided`), `payrollRepo.lockPayRun`, export in
`packages/db/src/index.ts`. *Done when:* legs green.
- Case 1. *Kills:* owed from ee only (1,050.00); month by `entry_date`/`period_start`; voided run counted.
- Case 12. *Kills:* person C dropped from month detail.
- Case 11 query leg (Σ outstanding = GL 22x0 per store, all-time, unaffected by a year filter). *Kills:* lines not per
  store; year-narrowed GL.

**S3 Record a payment.** `payroll/statutory-payments.ts` `recordStatutoryPayment`, capability `remit_statutory`
(+matrix row after `manage_payroll_rates`, label, area, scope; count pins), field rules, two POSTING-PATTERNS examples
+ fixtures if §7 Q-O1 is ruled yes. *Done when:* legs green, typecheck clean, guard/census unit files green.
- Cases 2, 3, 4 (legs exactly as §4). *Kills:* 6110 debited (§16.7); 2210 at paying store (DEF-551 shape); only first
  line posted.
- K2: 3 stores in one payment paid from Lipa -> Malvar and Rosario each get their own 1250/2150 pair with Lipa. *Kills:*
  `owingStoreId` = a line store (Rosario paired with Malvar).
- Cases 5, 7, 13, 15 (future month, 0 owed), 19. *Kills:* ceiling dropped; penalty into 2210/6110; employer check
  skipped; `Number()` sums.
- P1: paid from a 1140 e-wallet -> credit carries `party_type='money_account'`, `party_id` = account id. *Kills:* party
  dropped (P0001).
- P2: paid from a 1120 staff float -> refused with the T-486 sentence, nothing written. *Kills:* helper not called.
- R1: same `paymentId`, same inputs, twice -> one payment, one entry, second returns the first. *Kills:* server-minted
  id.
- R2: same `paymentId`, different amount (and separately, different `paid_on`) -> refused with the T-488 sentence,
  nothing new. *Kills:* bare `postEntry`; comparison skipped.
- R3: replay after the month is fully paid -> returns the original, not "overpaying". *Kills:* replay checked after the
  ceiling.
- R4: missing / non-uuid `paymentId` -> "This form is out of date…". *Kills:* `requireRequestId` skipped.
- K3 (case 14 rewritten): `paid_on` in a closed month -> the `periodRefusal` closed sentence, no rows; with an admin
  `periodOverride` -> posts, one `period_overrides` row; locked month -> refused even with override; no period ->
  "There is no fiscal period…". *Kills:* developer text from `postEntry`; payment row outside the transaction.
- Case 10 (two simultaneous full payments -> one refused). *Kills:* run lock removed.
- Case 16 domain leg (manager and staff refused). *Kills:* store-scoped capability.

**S4 Void + the pay-run guard.** `voidStatutoryPayment`, `voidPayRun` guard + `lockPayRun` (`payroll/index.ts` guard
and re-export only). *Done when:* legs green; existing `payroll.test.ts`, `t486-*`, `t436-*` green.
- Cases 8, 9, 20. *Kills:* voided lines counted as paid; guard missing (2210 Lipa −1,595); no payment lock (two
  reversals).
- Case 10 second half (payment racing a run void: one waits, then refuses). *Kills:* `voidPayRun` reads payments
  before locking the run.
- K4: void of a payment whose month is now closed, without `on` -> refused in words; with `on` in an open month ->
  reversal dated `on`. *Kills:* `reversalDate` always passed (moves an open-period reversal off its date).

**S5 Screens: list, record, detail.** `/payroll/statutory-payments` (owed vs paid, oldest unpaid first, filters,
mismatch banner), record form (paymentId hidden input, lines default to outstanding, 1120 omitted from the picker,
closed-month override fields for admins), payment detail + void; `route-capability.ts` entry (longer prefix wins over
`/payroll`); `CONSTRAINT_MESSAGES` entries for `statutory_payments_posted_reference_unique` and the two trigger
constraints. *Done when:* lib tests green; ERP typecheck; §9.4 smoke of record + void.
- Lib: picker omits 1120 (*kills:* list not filtered); the form renders a uuid `paymentId` per render (*kills:* fixed
  id); manager loader returns nothing (*kills:* menu-only gate).

**S6 Month detail, CSV, employer numbers, tile.** Month detail + CSV (loader-gated, never "BIR-ready"), employer
numbers + due days on `/payroll/rates` (`manage_payroll_rates`, audited), dashboard tile (admin only). *Done when:*
cases 12 (screen) and 16 (CSV + employer edit) green; full §9.4 smoke with screenshots; full suite green on a fresh gate
DB (migration with CHECKs + triggers), via the PR route.
- Case 16 remainder. *Kills:* CSV gated only by the menu; manager edits employer numbers.
- K5: report shows due date (due_day of month+1, clamped), days late, 5-day warning, estimated penalty not posted.
  *Kills:* estimate posted to the ledger.

## 6. Fences

- Write ONLY: the paths in the old spec's table, plus `packages/domain/src/field-rules/payroll.ts`,
  `packages/db/src/repo/payroll.ts` (`lockPayRun` only), `apps/erp/src/lib/constraint-messages.ts` (new keys only),
  the six chart pins in `chart-of-accounts.test.ts`, and, only if §7 Q-O1 = yes, `docs/POSTING-PATTERNS.md` +
  `tests/worked-examples/fixtures.ts` (new headings only).
- Do NOT change `postEntry`, `postEntryOnce`, `reverseEntry`, `withInterStoreLegs`, `payrollMoneyParty`,
  `assertPayrollMoneyAccount`, `STATUTORY_AGENCIES`, `RESERVED_LIABILITY_CODES`, `closePeriod`, or
  `reports/unpaid-liabilities.ts`.
- `voidPayRun`: add `lockPayRun` + the guard only; amounts, reversal dates, unfreeze and leave release unchanged.
- No new raw `throw new Error` anywhere (throw ratchet). No `Number()` on money. No `db:generate`. Applied migrations
  untouched. No bible edits (the orchestrator records the §16.5 note).
- An unpaid or partly paid statutory month never blocks a month close (it is a liability, not a draft).
- ⛔ Never `git worktree remove --force` this worktree.

## 7. Questions

**For Ian: none.** Nothing here needs a new business decision. The closed-month override follows the expense rule
he already has; refusing the staff float follows T-486 (its own open question to Ian already covers "should payroll
ever be paid from a staff float").

**For the orchestrator (planner/accounting, not Ian):**
- **Q-O1, missing worked examples.** POSTING-PATTERNS has only the same-store, no-penalty statutory shape (1383-1401,
  source type `liability_payment`). Recommend: S3 adds a section "Statutory payment (`statutory_payment`)" with three
  examples and fixtures: `statutory_payment.same-store`, `statutory_payment.cross-store`,
  `statutory_payment.with-penalty`, legs exactly as §4; `posting-patterns-doc.test.ts` then keeps doc and fixtures in
  step. The old `liability_payment.statutory-remittance` example stays (it is the bible §16.5 illustration). If ruled
  no, S3 builds from §4 as composed and the gap is logged.
- **Q-O2, renumbering.** If 0220 or 0221 does not land first, the builder renumbers 0222 to head + 1 with `when` on the
  grid; confirm the merge order on the coord board before S1's PR.

## Orchestrator rulings (29 Oct)
- Yes: S3 adds three worked examples to docs/POSTING-PATTERNS.md under a new `statutory_payment` section (same store,
  cross-store, with penalty) with matching test fixtures.
- Migration order confirmed on the coord board: 0220 (T-398 S6, PR #94) -> 0221 (T-498 S1, PR #93) -> 0222 (this).
