# T-193: statutory remittance (paying SSS, PhilHealth, Pag-IBIG and BIR what payroll accrued)

**Status:** spec written 2026-10-17 (Opus planner), not started. Bible row 354 item 4 (Ian, 16 Oct): T-190 now,
then remittance T-193. Row 217: the business deducts, adds the employer share and remits itself.
**Model:** Sonnet tester first (commits red), then Sonnet builder, per slice. Money path: never Haiku.
**Migration:** YES, one, hand-authored (ADR-012 §5): **0209 or the next free slot** (T-396 may also take one; whoever
lands second renumbers, journal idx and `when` = previous + 86400000).
**Depends on:** T-190 (shipped: 2f8e05b, 84a571b, c5d3435; payslip columns, `STATUTORY_PAYABLE_ACCOUNT`), T-189
(`voidPayRun`), T-128 (`RESERVED_LIABILITY_CODES` already refuses 2210-2240 in the generic liability screen).

## Goal (plain words)
Each month the business pays each agency what payroll set aside for it. The system shows what is owed per agency and
month, records each payment with the agency's receipt number, takes it off the 22x0 liability (never as a new cost),
and can prove, per person and month, what was contributed. A month that is late is visible, with its due date.

## Research, evaluate, propose (brief)
1. **Verdict: build it, at the size below.** Without it 2210-2240 only ever grow and the books say the agencies were
   never paid. Bible §16.5 calls this "cash that is really someone else's" and §16.7 defect #2 is exactly this gap.
2. **The stated reason holds.** Nothing else in v2 can settle 2210-2240: the generic liability screen refuses them on
   purpose (`packages/db/src/repo/liabilities.ts:27-30`), and an expense would book the cost a second time.
3. **What exists.** v1 (`ERP-rebuild/src/lib/payroll/recurring-rows.ts`) has five recurring-EXPENSE templates per store
   (SSS, PhilHealth, Pag-IBIG, withholding) with "not yet consumed by any journal-posting path". Live use: 0 pay runs,
   0 payslips, 0 remittances (phase-5 plan §1), so v1 is evidence of the NEED only (§1.2d). v2 has the accounts, the
   worked example (`POSTING-PATTERNS.md` `liability_payment.statutory-remittance`, fixture
   `tests/worked-examples/fixtures.ts:1331`), the cross-store pair and the payslip columns. POS/CUSTOMER/Website: none.
4. **Industry.** Every PH payroll package (and ERPNext's Payroll Payable + Payment Entry) does the same: obligation
   per agency per month from payslips, payment with the PRN / reference, a contribution list per employee (SSS R-3,
   PhilHealth RF-1, Pag-IBIG MCRF, BIR 1601-C). The official file formats and e-filing are out of scope below.
5. **Open source:** nothing worth adopting. The engines on GitHub are PH payroll calculators (already done in T-190);
   remittance is a few tables and one posting on our own ledger, and a dependency would not know our ledger.
6. **Effort against use:** about 4 agencies × 12 months = 48 payments a year per org, plus partial and catch-up ones.
   3 tables, 1 posting, 1 guard in `voidPayRun`, 2 screens and a report: about 3 builder days over 3 slices.
   Never built = 2210-2240 overstate liabilities forever and lateness is invisible until a penalty letter arrives.

## Naming (GLOSSARY first)
⛔ **"Remittance" is taken**: `remittances` (T-143) is the cashier's cash handover. Here the tables are
`statutory_payments`, the screen says "Government contributions: payments", the source type is `statutory_payment`.
"Month" = the calendar month of the pay run's `period_end` (T-190's MTD rule), stored as the 1st of that month.

## The model: owed is derived, payments are stored
- ⭐ **No obligation table and no stored totals.** What is owed for (org, agency, month, store) is summed live from
  POSTED, non-voided payslips of runs whose `period_end` falls in that month, at that store:
  SSS = `sss_ee + sss_er + sss_ec`, PhilHealth = `philhealth_ee + philhealth_er`, Pag-IBIG = `pagibig_ee + pagibig_er`,
  BIR = `withholding`. This is exactly what each payslip credited to 2210 / 2220 / 2230 / 2240 (`payroll/index.ts`),
  so the subledger is the payslips themselves. A straggler run posted later simply raises the month's owed figure.
- **Paid** = Σ non-voided `statutory_payment_lines` for the same (org, agency, month, store).
  **Outstanding** = owed − paid. Status is derived: `unpaid` (paid 0) · `partial` · `paid` (outstanding 0).
- **Per person** = the payslips behind the month, one row per payslip: person, the person's government number (read
  at report time), ee, er, EC, and "not deducted: no SSS no." from `skipped_agencies` (row 355). Fully paid month =
  every row paid. A partial month is partial as a whole; the agency, not us, allocates a short payment to people.
- **Reconciliation (§16.5 req. 6, invariant 6):** for each store and agency, Σ outstanding over all months = the GL
  balance of that 22x0 at that store. The report shows a red mismatch banner if not (e.g. a manual entry to 2210).

## The payment document
`statutory_payments`: org, agency (`sss` | `philhealth` | `pagibig` | `bir`), `month` (1st of month), `paid_on`,
`money_account_id`, `reference_no` (the agency receipt / PRN / BIR confirmation, required, trimmed, non-empty),
`penalty` (≥ 0, default 0), notes, `journal_entry_id`, status `posted` | `voided`, void reason/by/at, created by/at.
`statutory_payment_lines`: payment, store, `amount` (> 0). One line per store the payment settles. Unique
(payment, store).

**Recording (`recordStatutoryPayment`)**, one transaction:
1. `authorize(actor, 'remit_statutory')` (org scope), then for agencies other than BIR the org's employer number for
   that agency must be on file (`statutory_employers`), for BIR `organizations.tin`. Missing = typed refusal naming it.
2. `month` must be the 1st and not after the current month. Lock that month's posted `pay_runs` rows of the named
   stores FOR UPDATE in id order (so a concurrent void or second payment waits), then read owed and paid.
3. Each line ≤ that store's outstanding (typed refusal naming store and figure; overpaying is refused, as
   `payLiability` does). A store with nothing owed is refused. The form DEFAULTS each line to the outstanding figure
   (never retyped); lowering one is a partial payment.
4. `checkDraw` on the money account (`money-accounts/overdraft.ts`, same rule as every other outflow).
5. Insert the payment and lines, then `postEntry` (sourceType `statutory_payment`, sourceId = payment id,
   idempotencyKey `statutory_payment:{id}:post`, entryDate = `paid_on`). Period open/closed/locked is `postEntry`'s
   and the database's job; nothing is re-checked here. A refusal rolls back the whole transaction. Audit row.

**Voiding (`voidStatutoryPayment`)**: `remit_statutory`, reason required, posted only; `reverseEntry` dated `on`
(default `paid_on`; a closed period follows the existing override rules), status → voided, audit row. The month's
outstanding goes back up by itself (derived).

**Guard on payroll (`voidPayRun`)**: lock the run, then refuse if any non-voided `statutory_payment` exists for that
run's store and month for an agency where the run's payslips carry a non-zero amount. The refusal names the payment
and its reference no. and says: void that payment first, void the run, re-run, pay again. (Question 4.)

## GL posting (looked up, not decided)
Shape = `liability_payment.statutory-remittance` (POSTING-PATTERNS line 1274) plus, when the money account is at
another store, the cross-store pair of `reimbursement.payout-cross-store` (line 207: "an ap_payment drawn on another
store's account has exactly the same shape"). One entry per payment:
- per line: **Dr 22x0 at the line's store**, no party (0040 migration: statutory payables are party-free);
- per line whose store ≠ the money account's store: **Cr 2150 at the line's store** (party store = paying store) and
  **Dr 1250 at the paying store** (party store = line's store);
- if penalty > 0: **Dr penalty account at the paying store** (Question 3; shape = `expense.cash.simple`);
- **Cr the money account's GL code at its store**, Σ lines + penalty (party `money_account` when 1140, as
  `payLiability` does).
⛔ **The §16.7 double-count trap:** no line ever touches 6100-6130. The cost was booked when payroll posted. A
penalty is a NEW cost and goes only to the penalty account, never into 22x0.

## Due dates and lateness (§16.5 req. 1-3)
`statutory_employers`: org, agency (`sss` | `philhealth` | `pagibig` | `bir`), `employer_no` (digits; NULL required for
`bir`, which uses `organizations.tin`), `due_day` (1-31: the day of the FOLLOWING month the payment is due; the
accountant sets it from the agency's schedule, which depends on the employer number and filing method: **verify**
each). Unique (org, agency). Edited with `manage_payroll_rates` (the accountant, T-190); every change audited.
Report: due date = `due_day` of month + 1 (clamped to month end); days late = today (or the last payment date) −
due; a month due within 5 days shows a warning. **Penalty estimate** is shown, not posted (Question 2).

## Authorization
New capability **`remit_statutory`**, org scope: super_admin ✅ · admin ✅ · manager **✗** · staff ✗. Records and
voids payments and reads the remittance report, including per-person government numbers (personal data; row 353).
Add to `packages/auth/src/capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md` (row after `manage_payroll_rates`),
`apps/erp/src/lib/route-capability.ts`; bump the capability counts in the three census tests. Every ✅ has a test
that the ✗ fires for a manager AND staff.

## Reports (S3)
1. **Owed vs paid**: one row per agency × month (stores summed, expandable per store): owed, paid, outstanding,
   status, due date, days late, estimated penalty. Oldest unpaid first. Filters: agency, year, store. Mismatch
   banner per store/agency when Σ outstanding ≠ GL 22x0.
2. **Month detail** (agency + month): per-person rows as above, the payments with reference no., CSV export
   (plain columns, NOT the agency's official upload format).
3. **Dashboard tile** (§16.5 req. 2): total unremitted and the age of the oldest unpaid month, beside cash. Admin only.

## Schema and migration (0209 or next free)
- Three tables above, each with `org_id`, same-org composite FKs (`(org_id, id)` uniques, as 0206 did for rate ids),
  `statutory_payments.money_account_id` and `statutory_payment_lines.store_id` same-org.
- CHECKs: `month` is the 1st (`extract(day from month) = 1`); `amount > 0`, `penalty >= 0`, both finite,
  numeric(14,2); `reference_no` = btrim(reference_no) and <> ''; status shape (`voided` ⇔ voided_at, by and reason
  all set); agency enum; `due_day` 1-31; `employer_no` digits only and NULL iff agency = `bir`.
- Immutability: app role gets INSERT on payments and lines, UPDATE only on the void columns of payments (GRANT
  UPDATE (status, void_reason, voided_by, voided_at), ADR-012 §5 4a), no DELETE; a trigger refuses un-voiding.
  `statutory_employers`: INSERT, UPDATE (employer_no, due_day), no DELETE.
- Classify all three in `packages/db/src/cutover/classification.ts` and `packages/db/src/rls/registry.ts`
  (org-scoped, same as `statutory_rates`). Indexes: payments (org, agency, month); lines (store).
- Penalty account per Question 3 (if 6810: one chart seed row + the migration's insert for existing orgs).

## Slices
- **S1 schema:** migration, schema file, classification, registry, repo (owed/paid queries, inserts, lock helper).
- **S2 domain:** record, void, position/month-detail queries, `voidPayRun` guard, capability + matrix.
- **S3 screens:** `/payroll/remittances` (owed vs paid), record form, payment detail + void, month detail + CSV,
  employer numbers + due days on `/payroll/rates`, dashboard tile.

| Who | Paths |
|---|---|
| BUILDER S1 | `packages/db/migrations/0209_t193_statutory_payments.sql` (or next free), `packages/db/migrations/meta/_journal.json`, `packages/db/schema/statutory.ts`, `packages/db/schema/index.ts`, `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts`, `packages/db/src/repo/statutory-payments.ts`, `packages/db/src/repo/index.ts`, `packages/db/seed/chart-of-accounts.ts` (only if Q3 = 6810) |
| BUILDER S2 | `packages/domain/src/payroll/remittance.ts` (new), `packages/domain/src/payroll/index.ts` (`voidPayRun` guard + re-export only), `packages/auth/src/capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md` |
| BUILDER S3 | `apps/erp/src/app/payroll/remittances/**`, `apps/erp/src/app/payroll/rates/**` (employer numbers section), `apps/erp/src/lib/route-capability.ts`, the dashboard tile file under `apps/erp/src/app/dashboard/**` (not tests) |
| TESTER | `packages/db/tests/integration/t193-statutory-payments-schema.test.ts`, `packages/domain/tests/integration/t193-statutory-remittance.test.ts`, `tests/unit/capability-matrix.test.ts`, `tests/unit/t337-capability-areas.test.ts`, `apps/erp/tests/access-defaults-lib.test.ts` (count bumps), `apps/erp/tests/t193-remittances-lib.test.ts` |

## Cases (T-190 seeded 2026 rows, semi-monthly; fixtures reuse `_fixtures/statutory-rates.ts`)
Base month **October 2026**: person A at Lipa, ₱10,400 basic each half (T-190 cases 1-2); person B at Malvar, same.
Per person October: SSS 1,585 + 1,595 = **3,180**; PhilHealth **1,040**; Pag-IBIG **400**; BIR 0.
1. **Owed derived.** SSS October: Lipa 3,180.00, Malvar 3,180.00, total 6,360.00, status unpaid; Pag-IBIG 400.00
   each store. *Mutant: owed from ee only → 1,050.00 per store; or month by `entry_date`/`period_start`.*
2. **Pay in full, same store.** Lipa bank (1140) pays Lipa SSS 3,180.00, ref "PRN-0001": Dr 2210 Lipa 3,180 · Cr 1140
   Lipa 3,180; Lipa SSS October paid; GL 2210 at Lipa = 0. Lines equal the worked-example fixture shape. ⛔ Σ6100-6130
   unchanged by the payment. *Mutant: payment debits 6110 (the §16.7 trap) → 6110 up 3,180 and 2210 still 3,180.*
3. **Cross-store.** Lipa bank pays Malvar SSS 3,180.00: Dr 2210 Malvar 3,180 · Cr 2150 Malvar 3,180 (party Lipa) ·
   Dr 1250 Lipa 3,180 (party Malvar) · Cr 1140 Lipa 3,180. *Mutant: 2210 debited at the paying store → Malvar 2210
   stays 3,180 and Lipa goes −3,180 (DEF-551 shape).*
4. **One payment, two stores.** One SSS payment, lines Lipa 3,180 + Malvar 3,180, Lipa bank 6,360, one entry, one
   reference no.; both stores paid. *Mutant: only the first line posted.*
5. **Partial, then rest.** Lipa SSS: pay 2,000.00 → partial, outstanding 1,180.00; pay 1,180.00 → paid; a third
   payment of 0.01 refused (overpaying). *Mutant: ceiling dropped → outstanding −0.01.*
6. **Straggler.** After case 5, a correction run at Lipa with period_end 31 Oct adds SSS 100.00 → October back to
   partial, outstanding 100.00. *Mutant: paid status stored and never re-derived.*
7. **Late with penalty.** Due day 30 (verify), paid 15 Dec with penalty 63.60: Dr 2210 3,180 · Dr penalty account
   63.60 · Cr cash 3,243.60; report shows days late. *Mutant: penalty into 2210 (outstanding −63.60) or into 6110.*
8. **Void payment.** Void case 2's payment: reversal posts, status voided, outstanding back to 3,180.00; void again
   refused; void without a reason refused. *Mutant: voided lines still counted as paid.*
9. **Void pay run after payment.** Void A's October second-half run while case 2's payment stands → refused, naming
   "PRN-0001". After voiding the payment, the run void succeeds. *Mutant: guard missing → 2210 Lipa −1,595.*
10. **Concurrency.** Two simultaneous 3,180.00 payments for Lipa SSS October: one succeeds, one is refused as
    overpaying (the pay-run lock). Same for a payment racing a run void. *Mutant: lock removed → paid 6,360.*
11. **Reconciliation.** After cases 1-8, Σ outstanding per store and agency = GL balance of 2210/2220/2230/2240 at
    that store. *Mutant: lines not per store → Malvar mismatch.*
12. **Skipped agency (row 355).** Person C at Lipa, no SSS no.: no SSS owed from C; month detail lists C as "not
    deducted: no SSS no." with 0.00. *Mutant: C dropped from the list (the catch-up exposure becomes invisible).*
13. **Employer number.** SSS payment with no SSS employer no. on file → typed refusal; BIR payment with no org TIN →
    refusal; nothing written. *Mutant: check skipped.*
14. **Period lock.** `paid_on` in a closed period → `postEntry`'s refusal surfaces, no payment row remains.
    *Mutant: payment inserted outside the transaction → orphan row.*
15. **Bad month / nothing owed.** Month not the 1st (DB CHECK), a future month, or a store with 0 owed → refused.
16. **Authorization.** Manager and staff: record, void and report each refused (`remit_statutory` ✗); admin allowed;
    a manager cannot edit employer numbers (`manage_payroll_rates` ✗). *Mutant: store-scoped capability.*
17. **Schema.** As the app role: UPDATE of `amount`, `reference_no` or `penalty` refused; DELETE refused; un-void
    refused; empty or padded `reference_no` refused; `employer_no` set for `bir` refused. *Mutant: GRANT UPDATE all.*
18. **Org isolation.** Padre Garcia's admin cannot see or pay the main org's months (RLS + repo filter, §15.11).

## Smoke (§9.4, `docs/SMOKETEST.md`, port 9008)
Admin: set SSS employer no. + due day on `/payroll/rates`; post a pay run for October; open `/payroll/remittances`
and see SSS October owed per store; record a partial then the rest with a reference no.; the trial balance shows
2210 at 0 for that store and 6110 unchanged; void one payment and see the month go back to partial; the dashboard
tile shows the unremitted total. Sign in as a manager: menu item absent, direct URL refused. Screenshots in the report.

## Questions for Ian (Open Questions page; plain words, one recommended each)
1. **One employer number per agency for the whole company, or one per branch?** Company-wide (recommended: the
   company already has one TIN, and one payment can still cover several branches) vs per branch (a numbers table
   per store; more setup). The design supports both payment shapes; only where the number is stored changes.
2. **Penalties for paying late.** (a) Show an estimated penalty on the report and book the real one when it is paid
   (recommended: agency formulas change and differ, and a wrong automatic charge is wrong money) or (b) book an
   estimated penalty automatically each month a payment is late (what bible §16.5 req. 4 says; needs a
   per-agency formula table). Choosing (a) amends §16.5 req. 4; the orchestrator records it.
3. **Which account for penalties?** New **6810 Penalties and surcharges** (recommended: penalties are not tax
   deductible, so keeping them apart helps the accountant) vs the existing 6900 Other operating expenses.
4. **Fixing a payroll run after the month was paid.** Refuse until the payment is voided first (recommended: the
   books can never show the agency as overpaid by accident) vs allow it and show the month as overpaid.

## Out of scope (each with its reason)
- **BIR 1601-E / expanded withholding**: Shareat does not withhold on suppliers (bible row 354 item 3).
- **Official forms and e-filing** (SSS R-3, PhilHealth RF-1, Pag-IBIG MCRF, BIR 1601-C, 2316, 1604-C alphalist):
  agency formats change; the CSV in report 2 carries the data. A later task if the accountant wants files.
- **Catch-up of months skipped for a missing agency number** (T-190 "left for later"): the accountant decides; the
  month detail makes them visible.
- **SSS / Pag-IBIG salary-loan deductions** (v1 `staffPayrollDeductions`, 13 docs, "remit" treatment): no v2 payroll
  deduction feeds them yet. Flag to the orchestrator for `docs/CAPABILITY-GAPS.md`.
- **Overpayment credit carried to a later month**: refused instead (case 5).
- **Paying agencies through a bank API**: payments are recorded after they are made.

## Done when
All 18 cases green, full suite green on a fresh gate DB (a migration with CHECKs and a trigger), census,
classification and capability guards green, §9.4 smoke screenshots attached, and Ian's four answers recorded in the
bible (§16.5 amendment for Q2 by the orchestrator, not the builder).
