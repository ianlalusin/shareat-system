# T-190: payroll statutory contributions and withholding

**Status:** spec written 2026-10-16, not started. Ian, bible row 354 (16 Oct): start NOW from the official 2026
tables; staff data comes from the HR sheet due 31 Oct. Row 217: the business deducts, adds the employer share, and
remits itself (remittance is T-193).
**Model:** Sonnet tester first (commits red), then Sonnet builder, per slice. Money path: never Haiku.
**Migration:** YES, one, hand-authored (ADR-012 §5): **0206** (after T-434's 0204 and T-436's 0205), journal idx
206, `when` 1803871907084 (0205's + 86400000). Restates `payslips_net_identity_check` (schema/payroll.ts:270).
**Supersedes** `docs/plans/phase-5-payroll.md` §5 (wait for the first SSS number): bible row 354 says start now.
**Depends on:** T-189 (pay run, payslips, `postEntry`), T-191 (13th month), T-332 (payday policy per store).

## Goal (plain words)
Every payslip deducts the staff member's SSS, PhilHealth and Pag-IBIG share and their income tax, adds the
business's own share as a cost, and leaves what is owed to each agency sitting on 2210-2240 until T-193 pays it.
The rates live in a table an admin can update (no deploy), and a pay run will not POST until the accountant has
confirmed the rates it uses. "The accountant" = whoever Ian gives `manage_payroll_rates`.

## Rates (seeded as DATA, effective 2026-01-01, every row `confirmed_at = null` until the accountant confirms)
| Agency | 2026 figure seeded | Source | Confidence |
|---|---|---|---|
| SSS | 15% of MSC: employee 5%, employer 10%. MSC = compensation rounded to the nearest ₱500 (half up), floor ₱5,000, ceiling ₱35,000. EC (employer only): ₱10 if MSC < ₱15,000, else ₱30 | SSS Circular 2024-006 (RA 11199 final step, 2025) | **verify**: no 2026 circular seen; v1's 4.5% / ₱4,000-₱30,000 is the 2023-24 table and is WRONG now |
| PhilHealth | 5% of monthly BASIC salary, split 50/50 (ee 2.5%, er 2.5%), floor ₱10,000, ceiling ₱100,000 | RA 11223 §10; PhilHealth Circular 2020-0005 | **verify**: 2026 rate (bills to lower it were pending) |
| Pag-IBIG | Employee 2% (1% if monthly comp ≤ ₱1,500), employer 2%, fund-salary cap ₱10,000 (max ₱200 each) | HDMF Circular 460 (from Feb 2024) | **verify** basis (basic vs gross) |
| Withholding | RR 11-2018 Annex E tables "1 Jan 2023 onwards" (TRAIN, RA 10963), per frequency. Semi-monthly: ≤10,417 nil; 10,417-16,666 15% over 10,417; 16,667-33,332 937.50 + 20% over 16,667; 33,333-83,332 4,270.70 + 25%; 83,333-333,332 16,770.70 + 30%; ≥333,333 91,770.70 + 35%. Monthly and weekly rows as v1's `statutory.ts:79-104` (checked, same RR) | RR 11-2018 | high |
| 13th month + other benefits | Tax-exempt up to ₱90,000 a year | RA 10963 §32(B)(7)(e) | high |
| Minimum wage (MWE) | One row per store, effective-dated, from the region's wage order | Regional wage orders; RA 9504 | **verify** each store's region and current rate |
| De minimis | Not seeded: no payslip component pays any today | RR 11-2018 (amended since: verify) | n/a |

**Seeding:** the migration seeds the MAIN org only. Padre Garcia (row 305) gets none, so its payroll POST is refused
until its rows are added and confirmed. All four reference tables are per-org (`org_id`, RLS registry: org-scoped,
same as `pay_rates`), withholding brackets included, so each org confirms its own.

## Lookups, refusals, immutability
- Every lookup (contribution rows, withholding brackets, minimum wage) is **as of the run's `period_end`**.
  Contribution rows take effect only on the 1st of a month (CHECK; a mid-month `effective_from` is refused).
- A missing row (no contribution row, no bracket set for the store's frequency, no minimum wage for the store) is a
  **typed refusal** naming what is missing. Never fall back to "taxable" or to zero.
- POST refuses unless every row it uses (including `minimum_wages`) has `confirmed_at`. Preview works and warns.
- **Rows are immutable once confirmed or used.** No UPDATE except setting `confirmed_at/by` once (GRANT UPDATE on
  those two columns only, ADR-012 §5 4a; a trigger refuses re-confirming). A correction is a NEW row with a later
  `effective_from`. An unconfirmed, never-used row may be deleted; a used one cannot (payslip FK, restrict).
  Every add, confirm and delete writes `audit_log`. Add/confirm/delete require `manage_payroll_rates`.

## What counts (v1 requirements, `ERP-rebuild/src/lib/payroll/statutory.ts`, read as requirements only)
- **Contribution base** is a column on each rate row (`base_kind`: `gross` or `basic`), not code. Seed: SSS = gross
  (basic + OT + night diff + holiday, "all actual remuneration"); PhilHealth = basic; Pag-IBIG = basic. Verify.
- **Taxable** = gross − the employee's three contributions. **MWE**: if the employment's daily rate ≤ the store's
  minimum wage on the period end, basic + OT + night diff + holiday are all exempt, withholding = 0 (contributions
  still apply). ₱1 above the minimum is not an MWE (RR 11-2018; verify).
- **13th month (T-191)**: no contributions, no withholding, while the person's year-to-date 13th month is ≤ ₱90,000.
  Above that the run refuses with a typed refusal naming the person (nobody is near it; the accountant decides).
- **Missing agency number (Ian, 16 Oct).** If the person has no number on file for an agency, that agency is
  NOT deducted for them: employee AND employer share both 0, no 22x0 line. The payslip stores which agencies were
  skipped (`skipped_agencies`) and shows "not deducted: no SSS no." (PhilHealth no., Pag-IBIG no.). The preview
  lists every person and agency missing a number. The number is read at POST time, so a later edit never changes
  an old payslip. **No back-deduction:** once the number is added, deductions start from the next run, and that
  agency's MTD base counts only payslips where the agency WAS deducted. Withholding is unaffected (a TIN is not
  needed to compute it; T-193 needs it to report). ⚠️ The skipped months are still owed to the agency by law;
  the accountant decides any catch-up (left for later).
- **Separation final pay (T-192)** stays untouched by T-190 (left to a follow-up; see "Left for later").

## Semi-monthly and weekly: month-to-date true-up (beats v1's ÷2 estimate)
Contributions are monthly obligations. A payslip belongs to the calendar month of its run's `period_end`.
**The rule**, per agency, per side (employee, employer, EC), on every run:
1. MTD base = this payslip's base + the base of every POSTED, non-voided payslip of the same PERSON in the org that
   month where this agency was deducted (two employments = one employer, one contribution; skipped payslips excluded).
2. Monthly figure = the table applied to the MTD base, rounded half-up to the centavo (core money `mulRate`).
3. This run = monthly figure − already deducted this month for that agency and side, floor 0.
So the last run of the month lands the exact monthly figure whatever the number of paydays (2 or 5).
Withholding uses the store's frequency table (T-332 `payrollPeriodType`) on the period's taxable pay (the BIR
per-payroll method). Order: statutory first, then advance recovery from what is left, so net never goes below 0.
If the employee shares exceed gross, cut them in the order SSS → PhilHealth → Pag-IBIG until they fit, never below 0
and never below zero net; the **employer share always posts in full**. The next run in the same month retries the
cut part automatically (step 3); a shortfall left at month end is listed for the accountant (a query, no table).
Post AND void lock every affected person's `persons` row FOR UPDATE, in id order, before reading or changing MTD.

## Posting (one entry per payslip, as T-189, so void still reverses it whole)
Dr 6100 gross · Dr 6110 SSS employer + EC · Dr 6120 PhilHealth employer · Dr 6130 Pag-IBIG employer ·
Cr 2210/2220/2230 employee + employer share · Cr 2240 withholding · Cr 1230 advance · Cr cash net. Zero lines omitted.
⛔ **The §16.7 double-count trap, twice.** (1) The employee share is already INSIDE 6100 gross: it is never debited
to 6110-6130 too. Expense = gross + employer share, never more. (2) T-193's remittance is Dr 22x0 / Cr cash,
pure balance sheet (POSTING-PATTERNS `liability_payment.statutory-remittance`); routing it through the generic
expense action books the same cost a second time.

## Schema (one migration)
All four tables carry `org_id` and `source_ref`, are append-only as above, and are audited.
- `statutory_rates`: agency (`sss`/`philhealth`/`pagibig`), effective_from, ee_rate, er_rate, base_kind, floor,
  ceiling, step (SSS 500), low_threshold + low_ee_rate (Pag-IBIG), ec_threshold / ec_low / ec_high (SSS),
  source_ref, confirmed_at/by. Unique (org, agency, effective_from).
- `withholding_brackets`: frequency, effective_from, over, base_tax, rate, source_ref, confirmed_at/by.
- `minimum_wages`: store_id, effective_from, daily_rate, wage_order_ref, confirmed_at/by.
- `persons`: sss_no (10 digits), philhealth_no (12), pagibig_no (12), tin (9-12), format CHECKs, nullable.
  Government IDs are personal data: read only behind `run_payroll` / `enrol_staff`, store-scoped (row 353, T-435).
- `payslips`: sss_ee, philhealth_ee, pagibig_ee, withholding, sss_er, sss_ec, philhealth_er, pagibig_er,
  taxable_pay, is_mwe, skipped_agencies (subset of sss/philhealth/pagibig), and the rate row ids used (same "re-read March in June" rule as `pay_rate_id`).
  Restate `net = gross − sss_ee − philhealth_ee − pagibig_ee − withholding − advance_recovered`;
  `advance_recovered ≤ gross − (the four)`; every new money column **NOT NULL DEFAULT 0** (so the restated CHECK can
  never evaluate NULL on existing rows), ≥ 0 and finite.
- Classify all four new tables in `cutover/classification.ts` and `rls/registry.ts`. New capability
  `manage_payroll_rates` (org, admin only) in CAPABILITY-MATRIX.md, with a test that the ✗ fires for a manager.

## Slices
- **S1 schema:** the migration, seed of the 2026 rows, schema files, classification, registry.
- **S2 engine:** pure `statutory.ts` taking rate rows + MTD totals in, amounts out. No constants in code.
- **S3 pay run:** preview, post, void, MTD, locks, posting lines, 13th-month cap, unconfirmed-rate refusal.
- **S4 screens:** rates list / add row / confirm; government IDs on the staff page; payslip shows each line; preview
  warns "rates not confirmed" and "missing government IDs".

| Who | Paths |
|---|---|
| BUILDER | `packages/db/migrations/0206_t190_statutory.sql`, `packages/db/schema/{payroll,persons,statutory}.ts`, `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts`, `packages/db/src/repo/{payroll,statutory,persons}.ts`, `packages/domain/src/payroll/{statutory,index,thirteenth-month}.ts`, `apps/erp/src/app/payroll/**` (not tests), `apps/erp/src/app/staff/**` (not tests), `docs/decisions/CAPABILITY-MATRIX.md` |
| TESTER | `packages/domain/src/payroll/statutory.test.ts`, `packages/domain/tests/integration/t190-statutory.test.ts`, `packages/db/tests/integration/t190-statutory-schema.test.ts` |

## Cases (seeded 2026 rows; semi-monthly store; MTD = month-to-date)
1. **First half, ₱800/day × 13 = ₱10,400 basic.** SSS MSC 10,500 → ee 525.00, er 1,050.00, EC 10.00; PhilHealth
   520.00 → ee 260.00, er 260.00; Pag-IBIG cap 10,000 → ee 200.00, er 200.00; taxable 9,415.00 → tax 0; net
   9,415.00. *Mutant: v1's 4.5% / ₱30,000 constants → SSS ee 472.50.*
2. **Second half, same pay (MTD 20,800).** SSS MSC 21,000 → ee 1,050 − 525 = 525.00, EC 30 − 10 = 20.00;
   PhilHealth ee 520 − 260 = 260.00; Pag-IBIG ee 200 − 200 = 0.00; net 9,615.00. *Mutant: period base instead of MTD
   → Pag-IBIG ee 200.00 again (₱400 for the month).*
3. **Posting of case 1.** Dr 6100 10,400 · 6110 1,060 · 6120 260 · 6130 200; Cr 2210 1,585 · 2220 520 · 2230 400 ·
   cash 9,415; balances at 11,920; no 2240 line. *Mutant: employee share also debited to 6110-6130 → expense
   ₱985 too high (the §16.7 trap); assert Σ6100-6130 = gross + employer share.*
4. **Withholding, ₱20,000 basic, first half.** SSS ee 1,000; PhilHealth ee 500; Pag-IBIG ee 200; taxable 18,300 →
   937.50 + 20% × 1,633 = 1,264.10; net 17,035.90. *Mutant: tax on gross → 1,604.10.*
5. **Ceiling, same person second half (MTD 40,000).** SSS MSC capped 35,000 → ee 1,750 − 1,000 = 750.00.
   *Mutant: ceiling dropped → 1,000.00.*
6. **MWE.** Store minimum ₱695; rate ₱695 × 13 = 9,035 basic + holiday 2,780 + OT 1,000 = 12,815 gross. SSS on
   gross MSC 13,000 → ee 650; PhilHealth floor → ee 250; Pag-IBIG 2% × 9,035 = 180.70; withholding 0.00.
   *Mutant: MWE ignored → 197.60 (15% × 1,317.30).*
7. **MWE boundary.** ₱696 × 13 = 9,048 basic + 2,780 + 1,000 = 12,828: not MWE. SSS ee 650; PhilHealth ee 250;
   Pag-IBIG 180.96; taxable 11,747.04 → 15% × 1,330.04 = 199.51. *Mutant: comparison loosened → 0.00.*
8. **Statutory before advance.** New hire, 2 days × 800 = 1,600; advance owed 2,000. Statutory ee 250 + 250 + 32 =
   532; advance recovered 1,068; net 0; 932 still owed on 1230. *Mutant: advance first → CHECK fails / net < 0.*
9. **Pag-IBIG low band.** One day × ₱700 in the month: ee 1% = 7.00, er 2% = 14.00. *Mutant: er at 1%.*
10. **One person, two stores, same month.** ₱10,400 at A then ₱10,400 at B in the same half: Pag-IBIG ee 200 at A,
    0 at B. *Mutant: MTD per employment → ₱400.*
11. **Void then re-run.** Void case 1's run, re-run it: deductions equal case 1 again. *Mutant: MTD counts voided
    payslips → all zero.*
12. **Effective dating.** Add a SSS row from 2026-07-01 at ee 6%: June run uses 5%, July uses 6%, each payslip keeps
    its row id. *Mutant: newest row regardless of date.*
13. **Unconfirmed rates.** Preview works and warns; post refuses with a typed refusal naming the agency; same for an
    unconfirmed minimum wage. *Mutant: post ignores `confirmed_at`.* A manager adding OR confirming a row is
    refused (`manage_payroll_rates` ✗); an admin's add and confirm each write `audit_log`.
14. **13th month.** YTD ₱12,000 posts with no statutory lines; YTD exactly ₱90,000.00 posts exempt; ₱90,000.01
    refuses, naming the person.
    *Mutant: 13th month routed through contributions → SSS ee > 0.*
16. **Skip on missing number.** Case 1's person with no SSS no.: SSS ee/er/EC 0, no 2210 line, PhilHealth and
    Pag-IBIG as case 1, taxable 9,940.00, net 9,940.00, payslip shows "not deducted: no SSS no.", preview lists
    them. *Mutant: SSS deducted anyway, or only the employee share skipped (6110 still debited).*
17. **Resume, no back-deduction.** First half skipped (no SSS no.); number added; second half ₱10,400: SSS MTD base
    = 10,400 (the deducted payslips only) → ee 525.00, er 1,050.00, EC 10.00. *Mutant: MTD includes the skipped
    first half → ee 1,050.00 (back-deducted).* And the first-half payslip still shows "not deducted".
15. **Schema.** Insert a payslip whose net ignores withholding → `payslips_net_identity_check` rejects; sss_no of 9
    digits rejected; SSS row effective 2026-07-15 rejected; UPDATE of a confirmed row's `ee_rate` refused (as the app
    role); re-confirming refused; DELETE of a used row refused. *Mutant: CHECK not restated / UPDATE granted.*

18. **Contributions exceed gross.** One day × ₱400 in the month: ee SSS 250 + PhilHealth 250 + Pag-IBIG 1% 4 = 504 >
    400. Cut SSS first: SSS ee 146.00, PhilHealth 250.00, Pag-IBIG 4.00, net 0.00; employer SSS 500 + EC 10,
    PhilHealth 250, Pag-IBIG 8 post in full. *Mutant: v1's proportional scale (SSS 198.41) or employer share cut.*
19. **Weekly store, 5 paydays, ₱4,000 basic each.** SSS ee 250, 150, 200, 200, 200 (= 1,000); PhilHealth ee 250, 0,
    50, 100, 100 (= 500); Pag-IBIG ee 80, 80, 40, 0, 0 (= 200); withholding 0 (weekly ≤ 4,808). *Mutant: true-up
    only on the 2nd run of the month → weeks 3-5 zero.*
20. **Missing reference row.** A store with no minimum-wage row, or an org with no brackets for `weekly`: preview
    and post refuse, naming it. *Mutant: treated as taxable / non-MWE silently.*
21. **Void locks.** A void and a post for the same person run concurrently: both take the person lock in id order;
    the post's MTD sees the void's result (no double or missing deduction). *Mutant: void without the lock.*

## Left for T-193 and later (do not build here)
Paying the agencies (Dr 22x0 / Cr cash), due dates and penalties (bible §16.5), employer registration numbers,
SSS R-3 / PhilHealth RF-1 / Pag-IBIG MCRF / BIR 1601-C, year-end tax adjustment and BIR 2316 / 1604-C alphalist,
final-pay statutory (T-192), de minimis components, uncollected-shortfall settlement.

## Done when
All 21 cases green, full suite green on a fresh gate DB (migration with CHECKs), census and classification guards
green, and the accountant has confirmed (or corrected) every row marked **verify** before the first real POST.
