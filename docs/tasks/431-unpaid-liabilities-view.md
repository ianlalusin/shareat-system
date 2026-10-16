# T-431 — "Everything unpaid": one read-only view of what the business owes

> **Status:** spec written 2026-10-16, not started. Opus review approved with fixes, folded in 2026-10-16.
> **Source:** worklist `docs/plans/2026-10-14-ian-answers-worklist.md` row 10 · Ian's Q9 · bible §13 **row 327** ·
> Ian's answers of 16 Oct (§9).
> **Model:** Sonnet (builder and tester). **Migration:** none expected — read queries only. If the builder
> finds one is needed, stop and say so; do not write it.
> **Depends on:** nothing to start. Worklist #9 (catch-up runner) only adds more recurring drafts.

## 1. Goal, in plain words

A new page, **"Everything unpaid"**, that answers "what do we still owe, and to whom?" for a store. Every
unpaid thing, grouped by kind, a subtotal per kind and a grand total; every line links to its record.
Nothing is stored: each figure is worked out live from the module that owns it (row 327; DEF-074 is
answered by one view over the sources, not a fourth stored balance). The page changes nothing. The
existing `/liabilities` register stays exactly as it is (Ian, answer 2).

## 2. The kinds, in this order, and where each comes from

| # | Kind | Source of truth (reuse, do not re-derive) | Links to | Ledger account |
|---|---|---|---|---|
| 1 | Supplier invoices unpaid | `apRepo.openItems`' definition of "open" (posted expense, `credit` method, minus posted allocations, voided invoice excluded) | `/ap/invoices/[id]` | `2110` |
| 2 | Recurring bills drafted, not yet recorded | `recurring_expense_drafts` joined to an expense whose `status = 'draft'` | `/expenses/[id]` | none — a draft posts nothing |
| 3 | Other obligations (register) | `liabilitiesRepo.positionsByLiability` + store filter, outstanding > 0 | `/liabilities/[id]` | `2500` |
| 4 | Loans | `loansRepo.positionsByLoan` + store filter, principal outstanding (never interest) > 0 | `/loans/[id]` | `2400` |
| 5 | Wages worked, not yet paid | `previewPayRun` over unfrozen payable days; **net** pay per person | `/payroll?store=…` | none — payroll books and pays in one entry (DEF-162) |
| 6 | Other amounts owed in the books | ledger balance per account (and per party where the account has one), at the store | `/reports/trial-balance?store=…` | the list below |

**Kind 6 list (ruling).** IN: `2120` goods received not invoiced · `2130` owed to staff · `2140` customer
store credits · `2150` owed to another store (internal, see below) · `2160` service-charge float ·
`2210`–`2240` government contributions · `2250` VAT. OUT: `2900` suspense (a holding account, not a debt).
- `2250` is reserved and **no VAT is computed** (bible #75), so it is always empty today.
- `2210`–`2240` fill only from hand journals and opening balances — payroll does not post them.
- For kind 6 the ledger *is* the source, so "reconciles" means "equals its ledger balance".
- ⭐ **`2150` (ruling).** Shown at the **owing** store, one line per counterparty store, badged "internal",
  and **excluded from the all-stores grand total** (it nets to zero across the org). A store that is
  *owed* (`2150` below zero for that party) shows nothing for it on this page.
- `2300` is not on the list: it is always zero today (payroll posts nothing there). Named, not decided.

**Store filter for kinds 3 and 4.** `positionsByLiability` (`repo/liabilities.ts:185`) and `positionsByLoan`
(`repo/loans.ts:288`) are org-only. Add an optional `storeId` that filters on the **ledger line's**
`jl.store_id` — the same column the ledger comparison in §3 uses. ⚠️ DEF-145: a loan repayment docked from
another store's platform payout lands its `2400` line at that other store, so per store the loan looks
over-owed at one and under-owed at the other. That shows as a non-zero "Unmatched in the books" line and
the banner (§3) — expected, not hidden.

⛔ **One definition of "open AP".** Add a store-wide variant that shares `openItems`' SQL (one builder, optional
supplier filter). Do **not** copy `aging()`'s SQL — it lacks the voided-invoice filter.
⭐ **No double counting.** A draft's supplier invoice is not open AP (its expense is not posted). Once the
draft is posted on credit it leaves kind 2 and appears once in kind 1, tagged "from recurring: <name>".

**Speed.** Kinds 1, 2, 3, 4 and 6 are each **one query grouped by store**, never a loop over stores. Kind 5
calls `previewPayRun` once per store (accepted). Names via `accountLabel(code)` and `PersonName`; money summed
with `@shareat/core/money`, never `Number`.

## 3. Reconciliation — each kind against the part of its account it explains

No "booked total = all liability balances" check. Per store and per account: kind 1 vs `2110`, kind 3 vs
`2500`, kind 4 vs `2400`. The **leftover** (ledger balance minus the kind's lines; non-draft entries,
reversals included) is shown as an **"Unmatched in the books"** line inside that kind — never dropped — and
a non-zero leftover raises a banner naming the account and the amount. Kind 6 lines *are* ledger balances.
Kinds 2 and 5 sit under a separate "Not yet booked" subtotal and are not compared to the ledger.
Latent leftover source: `linkInvoiceToReceipt` (`domain/src/ap/invoice-link.ts:131`) can move a credit off
an open item; it has no live callers today. Named so a future leftover has a known suspect.

## 4. Who sees what

- Route `/liabilities/unpaid`, covered by `'/liabilities': 'view_financial_reports'` (owner/admin/manager,
  store-scoped). Linked from the `/liabilities` header.
- Store scope via `reportScope('/liabilities/unpaid', 'view_financial_reports', sp.store)` (the AP-aging pattern).
- ⛔ **Wages need `run_payroll` for that store** (Ian, answer 1). Without it, kind 5 reads "Visible to payroll
  staff only" — **no amount, no names** — and the grand total says it excludes wages. Check the capability
  **before** calling `previewPayRun` (it authorizes itself and throws). Days needing review or with no rate
  show as counts, "not included". If preview cannot compute (no attendance config), kind 5 shows why.

## 5. Layout

Kinds as sections in §2 order; overdue lines first; empty kinds say "Nothing unpaid". Below `sm` (375 px):
one `Card` per line (name · counterparty · due · amount), whole card is the link, no sideways scroll. At
`sm` and up: `Table` with `RowLink` rows. Subtotal under each kind; booked, not-yet-booked and grand totals last.

## 6. Files

**BUILDER (source and docs only):**
- `packages/db/src/repo/ap.ts` — store-wide open items sharing `openItems`' SQL, with the recurring template name.
- `packages/db/src/repo/liabilities.ts`, `packages/db/src/repo/loans.ts` — optional `storeId` on the two `positionsBy…` functions.
- `packages/db/src/repo/unpaid-liabilities.ts` (new) — unpaid recurring drafts; kind 6 balances; per-account ledger balances for the leftover; earliest unfrozen payable day. Export from the repo index.
- `packages/domain/src/reports/unpaid-liabilities.ts` (new) — `getUnpaidLiabilities(tx, actor, { storeId? })`; export from `reports/index`.
- `apps/erp/src/app/liabilities/unpaid/page.tsx` + `lib.ts` (new); header link in `apps/erp/src/app/liabilities/page.tsx`.
- `docs/POSTING-PATTERNS.md` L447 and L459 — doc fix: `2400` lines carry party type `loan` (party = the loan), not `supplier`.

**TESTER (tests only):** `packages/domain/tests/integration/t431-unpaid-liabilities.test.ts` ·
`apps/erp/tests/t431-unpaid-liabilities-page.test.ts`

## 7. Cases (each names the mutant it kills)

1. ₱8,000 credit invoice with ₱3,000 paid shows ₱5,000 in kind 1, linking to its invoice. *Kills: credit amount, not outstanding.*
2. A fully paid invoice is absent. *Kills: dropping the `> 0.005` open filter.*
3. Store C fixture: an invoice voided with `apRepo.markInvoiceVoided` directly (its expense stays posted). It is absent from kind 1, and store C's `2110` "Unmatched in the books" line equals its amount. *Kills: a second "open" definition copied from `aging()`.*
4. A recurring draft shows once in kind 2; its supplier invoice is not in kind 1. *Kills: AP read from `supplier_invoices` instead of posted expenses.*
5. That draft posted on credit: kind 2 empty, kind 1 has it once with the template name; grand total unchanged. *Kills: kind 2 keyed on a draft row existing, not `expense.status = 'draft'`.*
6. A draft posted then voided, a draft posted with cash, and a deleted draft are all absent. *Kills: `status <> 'posted'`; a dangling draft row counted.*
7. Register: charged ₱45,000, paid ₱20,000 shows ₱25,000; a settled one is absent. *Kills: showing charged, or zero rows.*
8. Loan disbursed ₱50,000, paid ₱5,000 principal + ₱300 interest shows ₱45,000; a paid-off loan is absent. *Kills: adding interest.*
9. A loan payment then its reversal: still ₱50,000 owed. *Kills: filtering out reversed entries (the T-126 bug).*
10. Stores A and B (clean): kind 1, 3 and 4 leftovers are exactly zero and no banner shows; store C (case 3) shows the banner. *Kills: leftover dropped, or kinds summed org-wide.*
11. Kinds 3 and 4 at store A exclude a liability and a loan recorded at store B. *Kills: missing `jl.store_id` filter.*
12. DEF-145: a loan repaid from store B's payout shows a non-zero `2400` leftover and the banner at both stores. *Kills: hiding the leftover.*
13. `2150`: Lipa owes Malvar ₱650 → shown at Lipa, badged internal; nothing at Malvar; the all-stores grand total excludes it. *Kills: 2150 in the grand total, or shown at the owed store.*
14. `2130` ₱1,200 owed to staff shows under `accountLabel('2130')` ("Reimbursements payable to employees"), not a code. *Kills: a raw code.*
15. `2250` is absent (zero today); a `2900` balance never appears. *Kills: suspense included.*
16. A `2210` opening balance appears in kind 6 equal to its ledger balance. *Kills: kind 6 missing a listed account.*
17. Payroll holder: kind 5 = `previewPayRun(...).totalNet`, per person; after `postPayRun` it is gone. *Kills: gross pay; frozen days counted.*
18. Manager without `run_payroll`: kind 5 hidden, no amount or person name anywhere in the result; grand total excludes it. *Kills: skipping the capability check.*
19. A person holding store A asking for store B gets nothing from B; staff are refused at `/liabilities/unpaid`. *Kills: no store filter; route falling through.*
20. Running the view twice changes no row in `journal_entries`, `expenses`, `recurring_expense_drafts`, `attendance_days.frozen_at`, `audit_log`. *Kills: the view triggering the runner or freezing days.*
21. No attendance config: kind 5 shows the reason, other kinds render. *Kills: payroll error blanking the page.*
22. Render: §2 order; every line's `href` points at its source; subtotals add to the totals; `Card` below `sm`, `Table`/`RowLink` above. *Kills: a line with no link; totals from display strings.*

## 8. Done when

- [ ] Cases 1–22 green; typecheck · unit · integration · build.
- [ ] Mutants for cases 3, 5, 10, 13 and 18 applied by hand, seen to fail, reverted (grep the diff).
- [ ] Driven in a browser at 375 px and desktop as an admin and as a manager; screenshots in the hand-back.

## 9. Ian's answers (16 Oct)
1. Wages owed are visible to payroll staff only; managers see "visible to payroll staff only" with no names or amounts.
2. A NEW "Everything unpaid" page, linked from Liabilities; the existing register stays as it is.
3. Include the other booked amounts owed: VAT payable, SSS / PhilHealth / Pag-IBIG and other government contributions, money owed back to staff, and money owed to another store. Each must reconcile to its GL balance.

**Orchestrator ruling (16 Oct) on 2300 wages owed:** include it in kind 6 when non-zero, under the same payroll-staff-only visibility as unpaid payroll (managers see "visible to payroll staff only"). Add one case.
