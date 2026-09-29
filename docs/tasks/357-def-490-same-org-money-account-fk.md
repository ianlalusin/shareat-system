# T-357: money-account references are same-org in the schema (DEF-490)

**Status:** DONE 2026-09-29 — APPROVED 2026-09-29 (orchestrator, after an independent Opus spec audit; amendments B1–B4 at the end bind). **Model:** Sonnet, tester then builder.
**Migration:** `0171_t357_def490_same_org_money_account_fk.sql`. The journal entry is idx 171, `when` = 1800847907084.
That is 0170's `1800761507084` (T-356) + 86_400_000.
**Why now:** Ian, 2026-09-29 (bible §13 row 244): *"yes fix DEF-490 before launch."*
**Runs after** T-355 (0169) and T-356 (0170). Line numbers were checked at HEAD `a47e0a7`. The catalog counts below
were measured read-only on `shareat_test` at 0168.

## Why
DEF-490 (`docs/DEFECTS-REGISTER.md`, the DEF-490 row):
- `sales_channels_destination_money_account_fk` is single-column (`0057:36`).
- As `shareat_app` with `app.org_id` = A, an INSERT or UPDATE that points an org-A channel at org B's money account is
  ACCEPTED:
  - RLS checks only the row's own `org_id`.
  - The FK check runs as the table owner and never consults `money_accounts`' RLS.
- The only defence is the domain: `setChannelPayoutDestination`, `packages/domain/src/channel-settlements/index.ts:660`,
  whose org-scoped `getById` is at `:685`. That is one layer for one risk (§15.11).
- ⚠️ **The register cites `repo/channel-settlements.ts:393-405` as the validation. That range is the repo writer
  `setDestinationAccount` (`:397-408`), which validates nothing.** The validation is the domain function above. The
  orchestrator should correct the register row.

## Rulings (planner, 2026-09-29)

- **R1: the census, measured.** `pg_constraint` on `shareat_test` holds **547 FKs**.
  - **360** run from a table with its own `org_id` to another table with its own `org_id` (excluding `organizations`
    itself). **None** carries `org_id` in its key.
  - **79 more** run from a derived-scope child (no `org_id` column) to an org-scoped parent.
  - By parent: persons 143, stores 71, journal_entries 19, items 19, **money_accounts 11** (+5 derived),
    stock_locations 9, suppliers 8, employments 8, the rest ≤5 each.
  - The general fix is its own project. It goes to Ian as Q1.
- **R2: the 16 FKs that reference `money_accounts`.**
  - The 11 whose child has its own `org_id NOT NULL` **join 0171.** Each is cheap: one `ADD CONSTRAINT`, and
    same-org holds by construction today, because every writer validates the account through the org-scoped
    `getById`.
  - The 5 derived-scope ones are a follow-up. They need an `org_id` column or a trigger.

  | # | Table.column | Schema | FK today | Nullable | 0171? |
  |---|---|---|---|---|---|
  | 1 | sales_channels.destination_money_account_id | `sales-days.ts:104` | `0057:36` | yes | **yes** (DEF-490 itself) |
  | 2 | channel_settlements.destination_money_account_id | `channel-settlements.ts:87` | `0057:152` | no | **yes** |
  | 3 | money_transfers.from_money_account_id | `money-transfers.ts:63` | `0027:61` | no | **yes** |
  | 4 | money_transfers.to_money_account_id | `money-transfers.ts:66` | `0027:63` | no | **yes** |
  | 5 | cash_requests.released_from_money_account_id | `cash-requests.ts:81` | `0034:84` | yes | **yes** |
  | 6 | ap_payments.money_account_id | `ap-payments.ts:65` | `0043:172` | no | **yes** |
  | 7 | ar_collections.money_account_id | `ar.ts:93` | `0049:137` | no | **yes** |
  | 8 | pay_runs.money_account_id | `payroll.ts:128` | `0105:39` | no | **yes** |
  | 9 | thirteenth_month_runs.money_account_id | `thirteenth-month.ts:54` | `0115:22` | no | **yes** |
  | 10 | separations.money_account_id | `separations.ts:84` | `0116:29` | yes | **yes** |
  | 11 | recurring_expenses.default_money_account_id | `recurring-expenses.ts:93` | `0132:67` | yes | **yes** |
  | 12 | expense_payments.money_account_id | `expenses.ts:230` | `0025:29` | yes | no: derived scope |
  | 13 | remittance_lines.from_money_account_id | `remittance.ts:105` | `0030:90` | no | no: derived scope |
  | 14 | remittance_lines.to_money_account_id | `remittance.ts:108` | `0030:91` | no | no: derived scope |
  | 15 | sales_day_tenders.money_account_id | `sales-days.ts:382` | `0023:49` | no | no: derived scope |
  | 16 | till_count_lines.money_account_id | `till-shifts.ts:164` | `0103:56` | no | no: derived scope |

- **R3: the shape, per 0159 step 8 (`0159:206-214`).**
  - `money_accounts` has **no** unique `(org_id, id)`. Measured: only `money_accounts_pkey (id)`, plus
    `org_store_name`, `foundation` and `one_float_per_store` uniques. 0171 adds
    `money_accounts_org_id_id_unique UNIQUE (org_id, id)`. It is trivially true, because `id` alone is unique.
  - Each of the 11 gets `FOREIGN KEY (org_id, <col>) REFERENCES money_accounts (org_id, id) ON DELETE RESTRICT`.
  - **MATCH SIMPLE** (the default, left unwritten, as in 0159): when `<col>` is NULL, the composite FK is skipped
    entirely. So the four nullable columns (#1, #5, #10, #11) still accept NULL, meaning no account chosen yet.
    `org_id` is NOT NULL on all 11, so a non-NULL `<col>` is always checked.
  - The **single-column FKs stay**, as 0159 kept its own. Dropping them buys nothing, and every name would need
    re-verifying (ADR-012 §3: 157 FK names differ from drizzle's).
  - Constraint names are `<table>_<col>_same_org_fk`. The builder checks each is ≤63 characters.
- **R4: the pre-flight fails closed, with a message.**
  - The first statement is a DO block. For each of the 11 FKs, it counts child rows whose `<col>` is non-NULL and
    whose `money_accounts.org_id` differs from the child's `org_id`.
  - If the total is > 0, it RAISEs, naming each non-zero FK and its count, plus *"DEF-490: no silent fix; each row
    needs a human decision"*. There is no UPDATE and no DELETE.
  - Is it blind the way T-354 R6's was? No: the migrator bypasses RLS (`postgres` is a superuser; `doadmin` is
    `rolbypassrls = t`, `docs/ops/README.md:41`).
  - Even if it were blind, `ADD CONSTRAINT … FOREIGN KEY` validates as the owner with RLS off, and would fail 23503
    anyway. The pre-flight exists for the readable message.
- **R5: the schema mirrors it, per ADR-012 §5.3 and the 0159 precedent.**
  - Each of the 11 tables gains a Drizzle `foreignKey({ columns: [t.orgId, t.<col>], foreignColumns:
    [moneyAccounts.orgId, moneyAccounts.id], name }).onDelete('restrict')`, with the comment shape of
    `schema/access.ts:279-289`.
  - `schema/money-accounts.ts` gets a `// NOTE: money_accounts_org_id_id_unique … hand-added in migration 0171`
    beside its extras (`:182-185`). That is how 0159 treated its unique.
- **R6: one existing test builds the exact shape this forbids, and it is RULED.**
  - The test: `apps/erp/tests/integration/t350-s6-followups.test.ts:142-185` (G2). It seeds an org-A channel
    pointing at org B's account, as admin (`:159-163`), to reach a `getById` miss.
  - After 0171 that seed is 23503. That is the point: the scenario becomes unreachable by schema.
  - The ruling: G2's seed becomes a savepointed assertion that the INSERT rejects `23503`. Its title records that
    the lookup-miss branch at `index.ts:726-744` is now defence in depth and unreachable across orgs.
  - ⚠️ This file is **uncommitted** in the tree today (`??`, T-350 S6). The orchestrator lands it before this task's
    tester edits it.
  - The tester also greps every test for other cross-org money-account seeds, on all 11 FKs, and lists each one.
    Each gets the same ruling only if cross-org IS its subject. Otherwise its fixture is fixed to same-org.
- **R7: residue on a lane database can trip the pre-flight.** A test DB that ran G2 still holds its cross-org channel
  row. There, 0171 RAISEs, which is correct. The remedy is to re-make that test database. Never edit the migration.

## BUILDER items

1. **The migration.** New file `packages/db/migrations/0171_t357_def490_same_org_money_account_fk.sql`, per ADR-012 §5.
   - **Header:** DEF-490, bible row 244, and Ian's quote. Then R1's counts, R2's 11-in / 5-out split, the MATCH
     SIMPLE sentence, and R4's why.
   - **Body:**
     - (1) The R4 DO block.
     - (2) `ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_org_id_id_unique" UNIQUE ("org_id", "id");`
     - (3) The 11 `ADD CONSTRAINT … FOREIGN KEY ("org_id", "<col>") REFERENCES "money_accounts" ("org_id", "id") ON DELETE RESTRICT;`
       in R2's order.
   - Every statement except the last ends `--> statement-breakpoint`. No data changes.
2. **Journal.** `packages/db/migrations/meta/_journal.json`: append
   `{ "idx": 171, "version": "7", "when": 1800847907084, "tag": "0171_t357_def490_same_org_money_account_fk", "breakpoints": true }`.
   ⛔ If 0170 is not in the journal yet, stop.
3. **Schema (R5).** Composite `foreignKey(...)` entries in `sales-days.ts` (`sales_channels`), `channel-settlements.ts`,
   `money-transfers.ts` (two), `cash-requests.ts`, `ap-payments.ts`, `ar.ts`, `payroll.ts` (`pay_runs`),
   `thirteenth-month.ts`, `separations.ts` and `recurring-expenses.ts`. Add the unique NOTE in `money-accounts.ts`.
   Add no new builder uniques; typecheck clean.

**BUILDER paths:** the new migration, `packages/db/migrations/meta/_journal.json`, and in `packages/db/schema/`:
`sales-days.ts`, `channel-settlements.ts`, `money-transfers.ts`, `cash-requests.ts`, `ap-payments.ts`, `ar.ts`,
`payroll.ts`, `thirteenth-month.ts`, `separations.ts`, `recurring-expenses.ts` and `money-accounts.ts`.
⛔ Not any applied migration, no repo/domain/app code, not the register or the bible, and no test file.

## TESTER paths
- **New file.** `packages/db/tests/integration/t357-same-org-money-account-fk.test.ts` holds K1-K2, F1-F5, N1 and M1-M2.
  - Real Postgres through `TEST_DATABASE_URL`, with the `_test` name guard.
  - Copy `asOrg` from `t354-immutability-triggers-always.test.ts:253` (`set local role shareat_app` plus `app.org_id`).
  - Seed two orgs, each with a store and a money account, in the `money_accounts` insert shape at
    `t350-s6-followups.test.ts:147-154`.
  - Every rejected statement runs under `tx.savepoint`. Today's red is recorded as the statement SUCCEEDING.
- **M1-M2** use the scratch-DB technique of `t349-s3-def456-repair-migration.test.ts` (a temp copy of `migrations/`
  filtered by journal `when`, never a hard-coded slot). Migrate to the entry before 0171, seed, then apply 0171.
- **New file.** `apps/erp/tests/integration/t357-payout-destination.test.ts` holds P1-P2, through
  `setChannelPayoutDestination` as the app role.
- **Ruled edits (R6).** G2 in `t350-s6-followups.test.ts`, plus any other cross-org seed the tester's grep finds.
  List each one in the TESTER report.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.

| Id | Case | Target | Red today |
|---|---|---|---|
| K1 | Catalog: for each of R2's 11 (table, col) | A `contype='f'` constraint exists with `conkey` = (org_id, col), `confrelid = money_accounts`, `confkey` = (org_id, id), `confdeltype = 'r'` | 0 of 11 exist |
| K2 | Catalog: `money_accounts` | A unique or PK constraint on exactly (org_id, id) exists. The single-column FKs on all 16 still exist (R3) | No (org_id, id) unique |
| F1 | **The measured red.** As `shareat_app`, `app.org_id` = A: INSERT an A `sales_channels` row whose `destination_money_account_id` = B's account | Rejects `code === '23503'` | ACCEPTED (1 row) |
| F2 | Same role: UPDATE an A channel's destination to B's account | Rejects `23503`; the stored value is unchanged | ACCEPTED (count 1) |
| F3 | Same-org positive control: the same INSERT and UPDATE with A's own account | Both succeed | Green (guard: F1/F2 are the org check, not a broken FK) |
| F4 | Owner (admin `sql`, bypasses RLS) cross-org INSERT of a `money_transfers` row (A transfer, B `to_money_account_id`) | Rejects `23503`. The composite applies whoever writes, the "second writer / manual fix-up" of DEF-490 | Accepted |
| F5 | Owner cross-org UPDATE of `recurring_expenses.default_money_account_id` (a nullable member of the 11) | Rejects `23503` | Accepted |
| N1 | NULL (MATCH SIMPLE): as the app role, INSERT an A channel with a NULL destination. Then UPDATE a set destination back to NULL | Both succeed | Green (guard) |
| M1 | Pre-flight: on a scratch DB at the entry before 0171, seed one cross-org `sales_channels` row and one cross-org `money_transfers` row (as admin), then apply 0171 | Rejects. The message names DEF-490, `sales_channels` = 1 and `money_transfers` = 1. After the attempt, no composite FK and no (org_id, id) unique exist (rolled back), and both seeded rows are unchanged | Red: 0171 absent (state this); a plain migrate would not raise |
| M2 | Positive control: the same scratch DB with same-org seeds only | 0171 applies; K1 holds on it | As M1 |
| P1 | `setChannelPayoutDestination` as the app role (real actor, `manage_store_settings`) to a same-org, same-store active account | `wrote: true`; the column holds the new id; one audit row | Green (guard: the only writer still works) |
| P2 | `setChannelPayoutDestination` with B's account id | Refused by the domain (its existing "does not exist" error, `index.ts:688`) before the DB is reached. The column is unchanged | Green (guard: the domain layer stays the first lock) |

Existing suites stay green UNCHANGED, apart from R6's ruled edits:
- `channel-settlements.test.ts`, `t350-channel-payout-change.test.ts`, `t350-s3-audit.test.ts` and `t350-s6-followups.test.ts`;
- `money-transfers.test.ts`, the cash-request, AP, AR, payroll, 13th-month, separations and recurring-expense suites;
- `migration-journal.test.ts`;
- **the full integration suite.** A 23503 anywhere else is a fixture seeding a cross-org account. Report it under R6;
  never weaken the FK.

## §9.4
1. Apply from zero on a scratch database (ADR-012 §5.8). Record `count(*)` and `max(created_at)` from
   `drizzle.__drizzle_migrations`, and paste
   `select conname, pg_get_constraintdef(oid) from pg_constraint where conname like '%same_org_fk'`. There must be 11
   rows.
2. Boot the app on 9008. Change a channel's payout account on the channel settings screen (T-350's flow). Screenshot
   the saved state and the audit entry. This proves P1 in the running app.
3. Record one money transfer between two of the store's accounts, and screenshot it saved. This proves a composite on
   a NOT NULL pair accepts same-org.

## Out of scope
- **The 5 derived-scope money-account FKs** (R2 #12-16). They need an `org_id` column or a trigger. That is a
  follow-up task, and Q1 below.
- **The other 349 org→org and 79 derived→org FKs** (R1). That is Q1.
- Dropping the single-column FKs (R3). Any repo, domain or app change.
- Anything against production. Production holds one organisation, so its pre-flight count is 0 by construction. The
  deploy applies 0171.

## Done when
- K1, K2, F1, F2, F4, F5 and M1 go red→green. F3, N1, M2, P1 and P2 stay green.
- Every suite named above, and the full integration suite, is green, with only R6's ruled edits.
- `migration-journal.test.ts` is green, and 0171 applies from zero. Typecheck is clean. The §9.4 substitutes are
  pasted. The builder edited no test file.
- **Orchestrator:**
  - DEF-490 → `fixed`, citing the commit.
  - Correct the register's `repo/channel-settlements.ts:393-405` citation (see Why).
  - Log the R2 #12-16 follow-up and Q1's answer.

## Questions for Ian
- **Q1: the same hole exists on 360 other foreign keys.**
  - What happens today: a record can point at another company's store or person, and only our code stops it, not
    the database.
  - The 360 break down as 143 to people, 71 to stores, 19 to journal entries, 19 to items, and more, plus 79 on
    tables that have no company column of their own.
  - This task fixes the 11 money-account links, which is what you ruled.
  - Closing all of them the same way is a planned, multi-migration job, roughly one per module, each with its own
    pre-check.
  - Should it be scheduled before launch, after launch, or only for the money- and people-related links (persons,
    stores, journal entries)?
  - The planner recommends: **after launch, persons + stores first.** Production has one company, so there is no
    other company to leak to until the second franchise owner is onboarded.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-29)
- **B1 — P1's actor is an ADMIN holding `set_channel_payout`**, not `manage_store_settings`:
  `packages/domain/src/channel-settlements/index.ts:682-683` authorizes `set_channel_payout` (T-350). A
  `manage_store_settings`-only actor is refused, so P1 would red for the wrong reason.
- **B2 — G2's intent is RETIRED, not preserved; say so.** After 0171 a `getById` miss on a stored destination is
  unreachable (`getById` filters id + org; RESTRICT forbids deletes), so the fallback near `index.ts:740` becomes
  dead defence. Ruling: rewrite `t350-s6-followups.test.ts` G2 as a same-org change asserting
  `before.moneyAccountId` = the stored id (a weaker guard that still reds if the code reverts to the lookup's id on a
  hit that differs), and record in the TESTER report that the cross-org fallback case is retired by 0171. The FK
  refusal itself is F1/F4's, not G2's.
- **B3 — before T-357's tester runs, re-make every lane DB that ran the uncommitted G2** (it holds a cross-org
  channel row; 0171's pre-flight correctly aborts there). Never edit the migration to pass.
- **B4 — Q1 ANSWERED (Ian, row 246): DEF-491, before a second org is onboarded.** Was: recommended trigger
  "before a second organisation is onboarded", not open-ended; persons + stores first. Ian decides.

## Record (orchestrator, 2026-09-29, from the pre-commit review)
- **T-350 S6's G2 fix (`index.ts:743`, `before.moneyAccountId` = the stored id) now has NO test guard.** The rewritten
  G2 is honest that it cannot tell "stored column" from "the lookup hit's own id" — the auditor reverted the fix and
  G2 stayed green. Acceptable only because 0171 makes the protected state (a cross-org lookup miss) impossible. If
  0171 is ever rolled back, that code is unguarded; do not read the green G2 as coverage of the stored-id rule.
