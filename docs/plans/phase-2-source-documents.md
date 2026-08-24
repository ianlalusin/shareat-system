# Phase 2 — Source documents, multi-tenancy, and the rolling pilot

| | |
|---|---|
| **Status** | Planned 2026-08-24 (Opus planner) |
| **Governed by** | `PROJECT_BIBLE.md`, especially rows 103–113 |
| **Research** | `docs/discovery/19-b2b-order-to-cash.md` (§3.6 satisfied — this plan was written after it, not before) |
| **Decides against** | ADR-005 (cutover), ADR-007 (pilot then purge), ADR-008 (multi-company) |
| **Prerequisite** | Phase 1 — **complete**, 15 of 15 |

## 1. Objective

Put the source documents that feed the ledger in front of real staff, **in priority order, while
still building** — so the Oct–Dec pilot exercises the paths that carry the most money for the
longest time, and 1 January opens on books whose every posting path has been used in anger.

### What "done" does NOT mean here

**Phase 2 has no feature-completeness gate** (bible row 113). A module not ready in October keeps
running in v1 for another month; v1 is live until 31 December regardless. **The checkpoints ask
*"is the 1 January cutover still safe?"*, never *"is Phase 2 finished?"*** — a checkpoint judged
against a fixed list during a rolling build fails every time it runs, and one that always fails is
one everybody learns to ignore.

---

## 2. Why this order, and it is not negotiable at the top

| | What | Why it comes first |
|---|---|---|
| **0** | **Foundations** — RLS policies, T-119 classification guard | Neither is a feature. Both are **per-table cheap and retrofit-expensive**: adding one policy as a table is created costs minutes; adding twenty later costs a week and misses one |
| **1** | **Expenses + Sales day** | **88% of all real activity** — `expense_payment` 4,396 legs and `sale` 2,945, measured from the capture, not guessed. What staff touch daily, so the pilot's longest exposure belongs here |
| **2** | **The five ledger-completeness modules** | Depreciation, prepaid/amortisation, loans, owner equity, generic liabilities. **All five post in v1 today.** Omit them and the books are understated from their first day (ADR-005's own scope-gap section) |
| **3** | **AP, AR, customers, price lists** | Relationship data. Needed before wholesale, and the subledger they feed is already built (T-118) |
| **4** | **Wholesale orders + inter-entity trade** | New capability. Real, but it serves one franchise and a dozen buyers — it does not outrank the paths carrying every peso the group earns |

> **The volume figures are the plan's spine, and they exist only because we captured first.** Every
> previous version of this sequencing would have been an opinion.

---

## 3. Decisions taken from the research — all three adopted

### 3.1 A dispatch IS the billing event

No separate invoice document, no interim clearing account, no unbilled-dispatch report. Goods go
out, the receivable exists, revenue recognises. Matches the lightest system studied and normal PH
practice for a short list of named buyers.

**The trigger to revisit is visible and specific:** a buyer asking for period-batched invoices.
Not a guess to build ahead of.

### 3.2 Credit limit: enforced, at exactly ONE gate

A dozen buyers on terms is where an unbounded receivable is a **real** risk, not a theoretical one.
Checked at **dispatch** — the single document that exists — with an **admin/manager override**,
matching the bypass pattern already used across the system.

**Explicitly NOT ERPNext's three separate check points.** We have one document; three gates for one
document is generality with no corresponding need.

> ⚠️ **Dolibarr ships an `outstanding_limit` field that is stored, displayed, and checked
> nowhere.** A control that looks real and is not — the same class as v1's AP tile being wired at
> three of eight write paths. **The test for this feature is a test that proves the block fires**,
> not a field on a form.

Bible §16.4 clarified: a credit **limit** is in scope; credit **scoring** remains out.

### 3.3 The buyer's side posts at `received`, not at `dispatched`

**Better than ADR-008 §4, which was silent on timing.** The seller posts when goods leave; the
buyer posts when they **confirm what actually arrived**.

That makes the receivable/payable reconciliation a check between **two independently confirmed
facts** rather than one party's claim recorded twice — so a short delivery or a dispute surfaces as
a disagreement instead of being silently absorbed. Every reference system agrees inter-entity
postings are never silent.

---

## 4. The task sequence

### Wave 0 — foundations (must precede every table below)

| # | Task |
|---|---|
| **T-119** | Data classification registry + build-failure guard + the cutover purge (**specced**) |
| **T-120** | RLS: the principal model (staff / customer), `set_config` at request boundary, policies on every existing table, and **connection-pool safety so an org never leaks between requests** |
| **T-121** | `organizations` becomes real: Padre Garcia as an org not a store; org-scoped roles; the franchisor's **sales-only** visibility into a franchise (ADR-008 §5) |

### Wave 1 — the 88%

| # | Task |
|---|---|
| **T-122** | Expense documents: categories, split payments, receipt photo gate, posting via `postEntry` |
| **T-123** | Sales day: unli / à la carte / discounts / comps, per store, posting the pattern T-108 pinned |

### Wave 2 — ledger completeness for January

| # | Task |
|---|---|
| **T-124** | Fixed assets + **scheduled depreciation** — the thing v1's stopped scheduler proves matters (DEF-044) |
| **T-125** | Prepaid items + amortisation |
| **T-126** | Loans: disbursement, payment, interest |
| **T-127** | Owner equity: capital contributions, drawings |
| **T-128** | Generic liabilities: charge and payment |

### Wave 3 — relationships

| # | Task |
|---|---|
| **T-129** | Customers + price lists (ADR-008 §2, §3). **Retail diners are NOT customers** (§11) |
| **T-130** | AP: supplier invoices, payments, open-item allocation against the 2110 subledger |
| **T-131** | AR: collections, allocation, aging |

### Wave 4 — new capability

| # | Task |
|---|---|
| **T-132** | Wholesale orders module in the ERP, staff-entered (ADR-008 §11) |
| **T-133** | Inter-entity trade: seller posts at dispatch, buyer at receipt, and the two reconcile (§3.3 above) |

---

## 5. What Phase 2 does NOT include

Inventory valuation and FIFO layers (**Phase 3** — and it gets its own research pass) · attendance
(Phase 4) · payroll (Phase 5) · the customer self-service portal (ADR-008 §10 — only when
self-service is actually wanted) · expense budgets · recurring-expense automation · anything on
ADR-005's *"can wait past January"* list.

## 6. How the checkpoints read this plan

| Date | The question |
|---|---|
| **30 Sep** | Is Wave 0 done and Wave 1 in staff hands? **If Wave 0 has slipped, that is the signal** — it is the only part that gets more expensive with delay |
| **31 Oct** | Are Waves 1–2 posting real transactions daily, and does the trial balance still tie over pilot data? |
| **15 Nov** | **Go/no-go for 1 January**, plus the **purge rehearsal** against a restored copy (ADR-007). Judged on whether the cutover is safe, not on the task list |
| **31 Dec** | Valued stock count · asset verification · **final v1 depreciation run**. One calendar entry, three jobs |

## 7. The risks worth naming now

| | |
|---|---|
| **Wave 0 slipping** | Everything after it becomes retrofit. RLS and classification are cheap per-table and expensive in bulk — **this is the one slip that compounds** |
| **A credit limit that does not fire** | Dolibarr shipped exactly that. The acceptance test is the block firing, never the field existing |
| **Padre Garcia trading in v1 first** | DEF-050 is live for that period: a separate company's books inside Ian's project, reachable by the store wildcard |
| **"The pilot data is too useful to delete"** | It will be said in December, by someone reasonable. Row 106 already answered it; the answer is still no |
