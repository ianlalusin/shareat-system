# T-431 — "Everything unpaid": one read-only view of what the business owes

> **Status:** spec written 2026-10-16, not started.
> **Source:** worklist `docs/plans/2026-10-14-ian-answers-worklist.md` row 10 · Ian's Q9 · bible §13 **row 327**.
> **Model:** Sonnet (builder and tester). **Migration:** none expected — read queries only. If the builder
> finds one is needed, stop and say so; do not write it.
> **Depends on:** nothing to start. Worklist #9 (catch-up runner) only adds more recurring drafts; this view reads whatever drafts exist.

## 1. Goal, in plain words

One page that answers "what do we still owe, and to whom?" for a store. It lists every unpaid thing,
grouped by kind, with a subtotal per kind and a grand total. Every line links to the record it came
from. Nothing is stored: each figure is worked out live from the module that owns it (row 327; DEF-074
is answered by one view over the sources, not a fourth stored balance). The page changes nothing.

## 2. The kinds, in this order, and where each comes from

| # | Kind | Source of truth (reuse, do not re-derive) | Line links to | In the GL? |
|---|---|---|---|---|
| 1 | Supplier invoices unpaid | `apRepo.openItems`' definition of "open" (posted expense, `credit` method, minus posted allocations, voided invoice excluded) | `/ap/invoices/[id]` | Yes — `2110` |
| 2 | Recurring bills drafted, not yet recorded | `recurring_expense_drafts` joined to an expense whose `status = 'draft'` | `/expenses/[id]` | **No** — a draft posts nothing |
| 3 | Other obligations (register) | `liabilitiesRepo.positionsByLiability`, outstanding > 0 | `/liabilities/[id]` | Yes — `2500` |
| 4 | Loans | `loansRepo.positionsByLoan`, outstanding (principal only, never interest) > 0 | `/loans/[id]` | Yes — `2400` |
| 5 | Wages worked, not yet paid | `previewPayRun` (payroll's own maths) over unfrozen payable days; **net** pay per person | `/payroll?store=…` | **No** — payroll books and pays in one entry; nothing posts to `2300` (DEF-162) |
| 6 | Other booked balances | Every other account with `accounts.type = 'liability'` and a non-zero balance at the store (VAT, SSS/PhilHealth/Pag-IBIG/tax, `2130` staff reimbursements, `2150` owed to another store, any `2300` opening balance) | `/reports/trial-balance?store=…` | Yes — by account |

⛔ **One definition of "open AP".** `openItems` takes a required supplier; add a store-wide variant that
shares the same SQL builder (one function with an optional supplier filter). Do **not** copy `aging()`'s
SQL — it lacks the voided-invoice filter, which is exactly the divergence case 3 catches.

⭐ **No double counting.** A recurring draft's supplier invoice is not open AP (its expense is not posted).
Once the draft is posted on credit it leaves kind 2 and appears once in kind 1, tagged "from recurring:
<template name>". Posted with cash or voided, it appears nowhere. Kind 6 excludes `2110`, `2400`, `2500`.

Names: use `accountLabel(code)` for accounts, `PersonName` for people (never a raw id). Money is summed
with `@shareat/core/money`, never `Number`.

## 3. Totals reconcile to the GL where they overlap

Booked kinds (1, 3, 4, 6) together equal the store's total liability balance in the GL (credit − debit
over non-draft entries, reversals **included** — they net). Per kind: kind 1 = `apRepo.orgAgingTotal(store)`;
kind 3 = `2500` at the store; kind 4 = `2400` at the store. Kinds 2 and 5 are shown under a separate
"Not yet booked" subtotal and are **not** compared to the GL, because nothing is posted until they are paid.
The page prints both subtotals, then the grand total, and a red banner if any booked kind disagrees with
its GL figure (the difference and the account named).

## 4. Who sees what

- Route: `/liabilities/unpaid` — already covered by `'/liabilities': 'view_financial_reports'` in
  `route-capability.ts` (owner/admin/manager; store-scoped). Linked from the `/liabilities` header.
- Store scope via `reportScope('/liabilities/unpaid', 'view_financial_reports', sp.store)` — the AP-aging
  pattern. "All stores" only for a person who covers the whole org; kinds group per store underneath.
- ⛔ **Payroll needs `run_payroll` for that store** (admin+; managers ✗ — CAPABILITY-MATRIX). Without it,
  kind 5 renders as "Wages owed are visible to payroll staff only" with **no amount and no names**, and the
  grand total says it excludes wages. Check the capability **before** calling `previewPayRun` (it
  authorizes itself and throws). Days needing review or with no rate are shown as counts, "not included".
- If `previewPayRun` cannot compute (no attendance config), kind 5 shows its reason; the page still renders.

## 5. Layout

Kinds as sections in the order above, each a `LinkRow` list (name · counterparty · due/age · amount) with
its subtotal; empty kinds say "Nothing unpaid". Works at 375 px with no sideways scroll (cards, not a
wide table). Overdue lines (AP due date, liability `due_on`, recurring due date passed) sort first in a kind.

## 6. Files

**BUILDER (source only):**
- `packages/db/src/repo/ap.ts` — store-wide open items sharing `openItems`' SQL; add `recurringTemplateName` via `recurring_expense_drafts`.
- `packages/db/src/repo/unpaid-liabilities.ts` (new) — unpaid recurring drafts at a store; liability-type account balances at a store; earliest unfrozen payable day at a store. Export from the repo index.
- `packages/domain/src/reports/unpaid-liabilities.ts` (new) — `getUnpaidLiabilities(tx, actor, { storeId })`, read-only, returns kinds + subtotals + reconciliation; export from `reports/index`.
- `apps/erp/src/app/liabilities/unpaid/page.tsx` + `lib.ts` (new); link in `apps/erp/src/app/liabilities/page.tsx` header.

**TESTER (tests only, disjoint from the above):**
- `packages/domain/tests/integration/t431-unpaid-liabilities.test.ts`
- `apps/erp/tests/t431-unpaid-liabilities-page.test.ts`

## 7. Cases (each names the mutant it kills)

1. A ₱8,000 credit invoice with ₱3,000 paid shows ₱5,000 under kind 1, linking to its invoice. *Kills: using the credit amount, not outstanding.*
2. A fully paid invoice is absent. *Kills: dropping the `> 0.005` open filter.*
3. A posted expense whose invoice was later voided is absent. *Kills: a second "open" definition copied from `aging()`.*
4. A recurring draft shows once under kind 2; its supplier invoice is not in kind 1. *Kills: AP read from `supplier_invoices` instead of posted expenses.*
5. That draft posted on credit: kind 2 empty, kind 1 has it once, tagged with the template name; grand total unchanged. *Kills: kind 2 keyed on a `recurring_expense_drafts` row existing rather than `expense.status = 'draft'` (counted twice).*
6. A draft posted with cash, and a voided draft, appear nowhere. *Kills: `status <> 'posted'` (voided counted).*
7. Register: a liability charged ₱45,000, paid ₱20,000 shows ₱25,000; a settled one is absent. *Kills: showing charged, or keeping zero rows.*
8. Loan disbursed ₱50,000, paid ₱5,000 principal + ₱300 interest shows ₱45,000; a paid-off loan is absent. *Kills: adding interest paid to what is owed.*
9. A loan payment then its reversal: still ₱50,000 owed, and kind 4 = `2400` at the store. *Kills: filtering out reversed entries (the T-126 bug).*
10. Kinds 1, 3, 4 each equal their GL account balance at the store; booked total = all liability-type balances at the store. *Kills: kind 6 not excluding `2110`/`2400`/`2500` (double count).*
11. An opening `2210` balance appears in kind 6 under its account label. *Kills: kind 6 limited to a hard-coded code list.*
12. Payroll holder sees kind 5 = `previewPayRun(...).totalNet` over the same window, per person; after `postPayRun` the lines are gone. *Kills: gross instead of net; not excluding frozen days.*
13. A manager (no `run_payroll`) gets kind 5 hidden — no amount, no person names anywhere in the result — and the grand total excludes it. *Kills: calling payroll through the org principal and skipping the capability check.*
14. A person holding store A asking for store B gets nothing from B. *Kills: org-wide queries with no store filter.*
15. Staff are refused at `/liabilities/unpaid` (route resolves to `view_financial_reports`). *Kills: a route-capability entry that lets the new path fall through.*
16. Running the view twice changes no row in `journal_entries`, `expenses`, `recurring_expense_drafts`, `attendance_days.frozen_at`, `audit_log`. *Kills: the view triggering the recurring runner or freezing days.*
17. Store with no attendance config: kind 5 shows the reason, other kinds render. *Kills: payroll error blanking the page.*
18. Page render: kinds in the §2 order, each line's `href` points at its source record, subtotals add to the grand total. *Kills: a line with no link, or a total summed from rounded display strings.*

## 8. Done when

- [ ] Cases 1–18 green; typecheck · unit · integration · build.
- [ ] Mutants for cases 3, 5, 10 and 13 applied by hand and seen to fail, then reverted (grep the diff).
- [ ] Driven in a browser at 375 px and desktop as an admin and as a manager; screenshots in the hand-back.

## Ian's answers (16 Oct)
1. Wages owed are visible to payroll staff only; managers see "visible to payroll staff only" with no names or amounts.
2. A NEW "Everything unpaid" page, linked from Liabilities; the existing register stays as it is.
3. Include the other booked amounts owed: VAT payable, SSS / PhilHealth / Pag-IBIG and other government contributions, money owed back to staff, and money owed to another store. Each must reconcile to its GL balance.
