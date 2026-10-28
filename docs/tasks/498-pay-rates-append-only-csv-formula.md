# T-498 — Past pay rates cannot be rewritten; CSV downloads cannot carry live formulas

**Status:** spec written 2026-10-28 (Opus planner, AUDIT session). Source: Codex core audit reports in
`C:\Users\ianla\shareat-audits\OPEN\` — `core-payroll-rate-history-2026-10-28.md` (F33) and
`core-reporting-csv-formula-2026-10-28.md` (F34), plus one stale comment from `core-decision-source-drift-2026-10-28.md`
(F35's only code item). Numbers from the orchestrator: T-498, DEF-799 (F33), DEF-800 (F34). All three confirmed on
main e5195d8. Two PRs:
- **S1** (F33, migration) — branch `audit/t498-s1-pay-rates-append-only`, alone (a migration gates on the full suite).
- **S2 + S3** (F34 + the comment) — branch `audit/t498-s2-csv-formula`.

## S1 — F33 / DEF-799 (P2, latent): the app role can UPDATE or DELETE a historical pay rate
- T-189 §5.1 (`docs/tasks/189-pay-rates-and-the-pay-run.md:85`) forbids UPDATE/DELETE on `pay_rates`: a wrong rate is
  superseded by a new row so a saved payslip's basis stays explainable. `packages/db/schema/payroll.ts:59` calls it
  append-only. But 0105 creates the table with no history trigger, 0011:68 granted the app role SIUD on it, 0169 narrowed
  FUTURE tables only, and 0170's six revokes omit it. Codex reproduced an `UPDATE pay_rates SET amount = 1.00` committing
  as `shareat_app` with an org principal; a re-run of a voided pay run then priced at the rewritten rate.
- The app never rewrites a rate: `packages/db/src/repo/payroll.ts` only INSERTs and SELECTs (`insertPayRate`,
  `rateInForceOn`, the history list). No `FOR UPDATE` row lock on `pay_rates` was found — **re-check this**, because a
  REVOKE of UPDATE breaks any `SELECT … FOR UPDATE/SHARE` (see 0170's header, the `stock_movements` case).
- FKs: `pay_rates.employment_id` and `payslips.pay_rate_id` are `ON DELETE restrict`, so no cascade deletes a rate.
  `cutover/classification.ts:533` classes `pay_rates` as `keep` (no purge).

### Rulings
1. **Migration `0221`** (hand-authored, ADR-012 §5 checklist; journal `when` = **1805167907084**, which is 0220's + 86400000
   — 0220 is T-398 S6, not on main yet; the orchestrator renumbers at merge if needed). Three locks, the 0168/0170
   pattern:
   a. a `history_guard` trigger `pay_rates_append_only` — `BEFORE UPDATE OR DELETE … FOR EACH ROW`, raising SQLSTATE
      **23001** (as the other append-only guards do; copy one, e.g. `audit_log`'s) with a plain message: a pay rate is
      never changed or removed; enter a new rate with a later effective date. `REVOKE EXECUTE … FROM PUBLIC` on its
      function if the existing guards do;
   b. `ALTER TABLE "pay_rates" ENABLE ALWAYS TRIGGER "pay_rates_append_only"` (0168);
   c. `REVOKE UPDATE, DELETE ON "pay_rates" FROM "shareat_app"` — unless step "re-check" above found a row lock, in
      which case revoke DELETE only and say why in the header (0170's table shape).
   Header comment explains the defect, the three locks and why each is safe, like 0170.
2. Classify the trigger in `packages/db/src/triggers/registry.ts` (`history_guard`, `always`). Any other census/guard that
   lists triggers, revokes or app privileges (the build will tell you: run the db unit + integration guards) gets its
   entry — never loosen a guard to pass.
3. **Runbook row** in `docs/ops/README.md` (same table as 0219's row): **no precheck required** — the trigger refuses
   FUTURE updates/deletes only; existing rows are not re-checked and none is rewritten, so there is nothing a precheck
   could find that would block the migration. Optional, informational: **P0221a**
   `SELECT count(*) FROM pay_rates;` (read-only). State "Lands after 0220 (T-398 S6)". Status "Not yet run".
4. Test fixtures that UPDATE or DELETE `pay_rates` (grep every `tests/` tree; the list in the audit includes payroll,
   separation, leave, statutory, thirteenth-month, t435-fixture, t327) must change to insert a superseding row or use
   a fresh employment — never disable the trigger. Report which fixtures changed and why.

### Tests (red first, real Postgres, a DEDICATED fresh `*_test` DB built from zero)
`packages/db/tests/integration/t498-s1-pay-rates-append-only.test.ts`:
(a) as `shareat_app` with an org principal and a populated rate (positive control: `current_user` is `shareat_app`, the
row is visible), UPDATE is refused (42501 from the revoke); DELETE is refused (42501);
(b) as the table owner (bypassing the revoke), UPDATE and DELETE are refused by the trigger (23001) — proves the second
lock independently; also under `SET LOCAL session_replication_role = 'replica'` (proves `ENABLE ALWAYS`);
(c) INSERT of a superseding rate as `shareat_app` still works, and `rateInForceOn` picks it from its effective date;
(d) the full payroll lifecycle test (`packages/domain/tests/integration/payroll.test.ts`) stays green.

## S2 — F34 / DEF-800 (P3): CSV downloads keep formula-looking text
- `apps/erp/src/lib/csv.ts:7-12` `escapeCell` quotes separators only. A cell starting `=`, `+`, `-`, `@`, TAB or CR is
  read by Excel/Sheets as a formula. A settings writer can save a sales-channel name `=1+1`; the sales-rollup export
  (`apps/erp/src/app/reports/sales-rollup/export/route.ts:33`) writes it unchanged. Eight report exports share the helper.

### Rulings
5. In `escapeCell`, a **string** cell whose first character is one of `= + - @ \t \r` gets a leading `'` (single quote)
   so a spreadsheet shows it as text (OWASP CSV-injection guidance) — then the usual quoting runs on the result.
   **Exceptions, so numbers stay numbers:** a JS `number` is never prefixed; a string that is a plain number or
   money figure (`-12`, `-1,234.50`, `-₱303.03`, `₱-303.03` — whatever exact formats our exports emit; read them) is not
   prefixed. Write that pattern as one named, commented regex. `-1+1` is NOT a plain number → prefixed.
6. Find every other CSV writer in the tree (`grep -rn "text/csv\|toCsv\|csv" apps packages --include=*.ts`, e.g.
   `exportLeaveCsv` behind `apps/erp/src/app/attendance/leave/export/route.ts`). Each one that writes user-typed text
   (names, notes, labels) must use the shared `escapeCell` rule — import it, do not copy it. POS's statutory logbook is
   DEF-721 and out of scope. List every writer and what you did in the report.

### Tests (red first, unit)
`apps/erp/tests/t498-s2-csv-formula.test.ts`: each of `=1+1`, `+1+1`, `-1+1`, `@SUM(1,1)`, `\t=1`, `\r=1` comes out
inert (starts with `'`, quoted where needed); `-₱303.03`, `-12`, `1,234.50` and the number `-5` come out unchanged; a
value with comma/quote/newline is still quoted correctly after prefixing; the sales-rollup export route's CSV for a
channel named `=1+1` shows the inert cell (use the existing export test pattern if one exists, else the helper).

## S3 — the payroll comment (no DEF; F35's only code item)
`packages/domain/src/payroll/compute.ts:206-207` still says minutes become hours "in HALF-HOUR STEPS, remainder dropped
… 1h50m of overtime is 1.5 hours; 25 minutes is none". The dated ruling and table at `:14-40` and the code at `:48-55`
use thresholds 25/50 (25m = 0.5h, 1h50m = 2h). Rewrite the comment to match the table at the top of the file and point to
it. Comment only — no code change.

## Acceptance (each PR)
Red then green; root + ERP typecheck clean; the WHOLE unit project green (`npx vitest run --project unit
--testTimeout=120000 --maxWorkers=3`; re-run timeout-only failures alone); `tests/unit/register-row-shape.test.ts` green
with DEF-799 / DEF-800 rows in full row shape. S1 also: the db and payroll integration tests on a fresh DB; CI runs the
full suite. LF only.
