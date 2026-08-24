# Phase 1 — The Accounting Spine

**Status:** Planned, not started
**Written:** 2026-08-22 (Opus, planner role)
**Governed by:** `PROJECT_BIBLE.md` — especially §16 (the accounting spine), §1.2 (parity
contract), §15 (engineering standards)
**Prerequisite:** Phase 0 (§A below)

---

## 1. Objective

Build a **real double-entry general ledger** on PostgreSQL — with the complete nominal
ledger v1 never had — enforce the ten invariants as database constraints and CI tests,
and load real historical data through it so that the books demonstrably tie.

Phase 1 is the smallest thing that proves Shareat System is worth building. It is deliberately
scoped so it can be finished and judged.

### Exit gate — all must be true

1. All ten invariants (§16.1) pass in CI against the loaded dataset.
2. **The trial balance ties** — one query, debits = credits, at any moment.
3. **The income statement is a query** (`GROUP BY account_type` over `journal_lines`),
   not a maintained scan list. A newly added P&L account appears automatically.
4. Every worked example (§6) posts exactly the expected lines.
5. A posting into a closed period is **rejected**, by every path.
6. A single-leg entry is **impossible** — rejected by CHECK constraint.
7. The ETL audit report exists, quantifying where v1's books do not balance (§7).
8. A trial-balance screen renders in the running app on port 9008.

### Explicitly NOT in Phase 1

Source-document modules (expenses, AP, AR, sales day) — Phase 2. Inventory — Phase 3.
Attendance — Phase 4. Payroll — Phase 5. No UI beyond the walking skeleton's ledger
views. **Resist all of it**; the value here is a correct, finished spine.

---

## 2. Why this is Phase 1

Discovery (`docs/discovery/06-accounting-gaps.md`) found that v1 has **no nominal
ledger**: revenue and expense are not journal legs, so the P&L is hand-assembled from
scan blocks, and a single-leg entry is treated as "trivially balanced"
(`balancer.ts:64-67`). Most catalogued defects are downstream of that one choice.

Every other module posts *into* the ledger. Building inventory or payroll first means
reworking their postings later. Fix the spine, and a whole class of defects retires at
once rather than one at a time.

---

## A. Phase 0 prerequisites

Mechanical, but nothing in Phase 1 can start without them.

| Task | Delivers |
|---|---|
| **T-001** | Next.js 16 + TS + Tailwind + shadcn scaffold, dev on **port 9008** |
| **T-002** | Local PostgreSQL 18 on **port 5435**, Drizzle, forward-only migration runner |
| **T-003** | Env validation that **fails closed** on a missing var (§7 rule 9) + committed `.env.example` |
| **T-004** | Observability: structured logging with correlation ids, error tracking, slow-query log, health endpoint (§15.6) |
| **T-005** | Test harness: vitest unit + integration against **real Postgres**, CI running typecheck/lint/test on every push (§15.7) |
| **T-006** | Firebase Auth bridge — verify token server-side, resolve to a `person` row (§7.1) |
| **T-007** | Automated backup + a **rehearsed restore** (§15.8) |
| **T-008** | Time-boxed **offline spike** — prove the Firestore two-lane contract with a toy payload (§5). Spike only; delete the code |

---

## B. The chart of accounts — the central design deliverable

This is the piece that most needs Ian's eyes, because it encodes how he thinks about the
business. Proposed structure below: standard PH food-and-beverage, numeric codes, five
types, `legacy_code` carrying v1's string ids so every ETL mapping survives.

**Accounts marked 🆕 do not exist in v1 and are the substance of the fix.**

### 1000 — Assets
```
1100  Cash and cash equivalents
  1110  Cash on hand — cashier
  1120  Cash on hand — staff / custodian
  1130  Cash in bank
  1140  E-wallet / online channels
  1150  Undeposited funds (in transit)
1200  Receivables
  1210  Accounts receivable — CONTROL            🆕 (v1 has no control account)
  1220  Channel / platform receivable — CONTROL  🆕
  1230  Advances to employees
  1240  Other receivables
1300  Inventory                                   🆕 (entire group absent in v1)
  1310  Inventory — raw materials / meat          🆕
  1320  Inventory — supplies and packaging        🆕
  1330  Inventory — prepped / commissary goods    🆕
  1340  Inventory in transit (branch orders)      🆕
1400  Prepaid expenses
1500  Property and equipment
  1510  Equipment    1520  Furniture and fixtures    1530  Leasehold improvements
  1590  Accumulated depreciation  (contra-asset)
```

### 2000 — Liabilities
```
2110  Accounts payable — CONTROL                  🆕 (v1 posts to ap__{supplierId} directly)
2120  Accrued expenses
2200  Statutory payables
  2210  SSS payable            2220  PhilHealth payable
  2230  Pag-IBIG payable       2240  Withholding tax payable — compensation
  2250  VAT payable
2300  Payroll payable
2400  Loans payable
```

### 3000 — Equity
```
3100  Owner's capital     3200  Owner's drawings     3300  Retained earnings
```

### 4000 — Revenue 🆕 *(absent as journal legs in v1 — this is the core gap)*
```
4100  Food sales — unlimited     4150  Food sales — à la carte (incl. take-out)
4300  Food sales — delivery / channel              4400  Beverage sales
4900  Sales discounts  (contra-revenue)  🆕 ← senior / PWD, currently hardcoded to zero
4950  Sales returns and voids (contra-revenue)
```

### 5000 — Cost of sales 🆕 *(v1 expenses purchases on receipt; no COGS)*
```
5100  COGS — food        5200  COGS — beverage
5300  Wastage and spoilage          5400  Inventory adjustment (count variance)
```

### 6000 — Operating expenses
```
6100  Salaries and wages
6110  Employer SSS contribution        🆕 ← unbooked in v1
6120  Employer PhilHealth contribution 🆕 ← unbooked in v1
6130  Employer Pag-IBIG contribution   🆕 ← unbooked in v1
6140  13th month pay
6200  Rent          6300  Utilities        6400  Platform / channel fees
6500  Supplies      6600  Repairs and maintenance    6700  Depreciation
6800  Professional fees and permits     6900  Other operating expenses
```

### 7000 — Other income and expense
```
7100  Interest income    7200  Interest expense    7300  Other income
```

**Design rules:** only leaf accounts are `is_postable`. Parents roll up for reporting.
`store_id` lives on the journal *line*, so store-level P&L is a `GROUP BY`, not a
separate ledger per store. Supplier and customer detail lives in **subledgers** that
reconcile to 2110 and 1210 (invariant 6), not as thousands of GL accounts.

---

## C. Schema

```sql
organizations   (id, name, ...)                    -- one row for now; SEBN reserved
stores          (id, org_id, name, code, is_active, ...)
persons         (id, org_id, full_name, ...)       -- the identity spine (§7.1)

accounts        (id, org_id, code, name, type, normal_balance,
                 parent_id, is_postable, legacy_code UNIQUE, is_active)
                 type ∈ (asset, liability, equity, income, expense)
                 normal_balance ∈ (debit, credit)

fiscal_periods  (id, org_id, starts_on, ends_on, status)
                 status ∈ (open, closed, locked)
                 EXCLUDE constraint: no overlapping periods per org

journal_entries (id, org_id, entry_date, period_id, memo,
                 source_type, source_id, idempotency_key UNIQUE,
                 status, reversal_of_entry_id, posted_at, posted_by, created_at)
                 status ∈ (draft, posted, reversed)

journal_lines   (id, entry_id, line_no, account_id, store_id,
                 debit numeric(14,2) NOT NULL DEFAULT 0,
                 credit numeric(14,2) NOT NULL DEFAULT 0,
                 line_memo)
                 CHECK (debit >= 0 AND credit >= 0)
                 CHECK ((debit = 0) <> (credit = 0))   -- exactly one side

audit_log       (id, actor_person_id, action, entity, entity_id,
                 before, after, source, occurred_at)
```

**Enforcement, in the database — not in application code:**

| Rule | Mechanism | Timing |
|---|---|---|
| `debit >= 0`, `credit >= 0` | `CHECK` | immediate |
| exactly one of debit/credit populated | `CHECK ((debit = 0) <> (credit = 0))` | immediate |
| **Σ debit = Σ credit per entry** | **`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`** | **at COMMIT** |
| **at least two lines per entry** | same constraint trigger | at COMMIT |
| closed period | trigger rejecting insert/update where period ≠ `open` | immediate |
| posted immutability | trigger blocking UPDATE/DELETE on a posted entry | immediate |
| postable account | FK + `CHECK is_postable` | immediate |

> ⚠️ **PostgreSQL does not allow CHECK constraints to be DEFERRABLE.**
> `ERROR: CHECK constraints cannot be marked DEFERRABLE`. Only FOREIGN KEY, UNIQUE,
> PRIMARY KEY, EXCLUDE and **CONSTRAINT TRIGGERS** can be deferred.
>
> This matters because balance is inherently a **multi-row** rule: after the first line is
> inserted the entry is legitimately unbalanced, and it only has to be correct at COMMIT.
> So balance and minimum-two-lines **must** be a deferrable constraint trigger; per-row
> rules stay ordinary immediate CHECKs.
>
> Verified in `tests/integration/database.test.ts`, which proves an unbalanced state is
> tolerated mid-transaction and rejected at COMMIT with the whole unit rolled back.
> *(Found by that test — the first draft of it used a deferrable CHECK and Postgres
> refused it.)*

Application code cannot forget to call a validator, because there is no validator to call.

---

## D. Posting engine

`src/lib/services/ledger/`

```ts
postEntry(input: {
  orgId; entryDate; storeId?; memo;
  sourceType; sourceId; idempotencyKey;
  lines: { accountCode; storeId; debit?; credit?; memo? }[];
}): Promise<{ entryId; created: boolean }>

reverseEntry(entryId, reason, actor): Promise<{ reversalEntryId }>
```

- One transaction. Balance and period checked by the database, not by hand.
- **Idempotent** — re-posting the same `idempotency_key` returns the existing entry with
  `created: false`. Carries v1's good deterministic-id practice forward (§16.8).
- `reverseEntry` writes a **new** mirror-image entry linked by `reversal_of_entry_id`
  and flips the original to `reversed`. Never mutates posted lines (invariant 5).
- v1's pure builders in `src/lib/financial/journal/builders/` are **reused**, wrapped by
  an adapter mapping `direction: in/out` → debit/credit via each account's
  `normal_balance` (§16.3). Rewriting them would discard working domain knowledge.

---

## E. Reporting views

All derived. Nothing hand-maintained (§4.2 rule 7).

| View | Purpose |
|---|---|
| `v_account_balances` | Per account / store / period — debit, credit, net |
| `v_trial_balance` | Invariant 10, one query |
| `v_income_statement` | `GROUP BY account_type` over 4000–7000. **The fix for defect #4** |
| `v_balance_sheet` | 1000–3000, with the accounting equation asserted |
| `v_subledger_reconciliation` | AP/AR subledger totals vs control accounts (invariant 6) |

Start as plain views. Promote to materialised only if measurement shows a need — and
never to a hand-maintained table.

---

## F. The test suite — this is what replaces ERPNext's track record

Per decision #36, this is not optional overhead.

1. **Invariant suite** — the ten, executable, run in CI against the full dataset.
2. **Worked examples** — hand-computed *before* implementation, expected postings written
   out longhand: cash purchase; purchase on credit; partial supplier payment; sale with
   VAT; **sale with a senior/PWD discount**; a void and its reversal; a wastage
   write-off; a payroll run **including employer contributions**; a period close, then a
   rejected late posting.
3. **Property-based tests** — generate random valid transaction sets; assert the books
   still tie and the equation holds.
4. **Constraint tests** — prove the database *refuses* a single-leg entry, an unbalanced
   entry, a closed-period posting, and an edit to a posted line.

---

## G. ETL — and the audit

The hard and interesting part. v1's journal carries **balance-sheet legs only**, so
historical entries will not balance under the new constraints. That is the point.

**Two-stage strategy:**

### Stage 1 — Analysis mode (loads nothing)
Read all v1 `journal` docs, group by `sourceType:sourceId`, and for each group attempt to
derive the missing nominal leg from its source document (an `expenses` doc's category → a
6xxx account; a `salesDays` breakdown → 4xxx; and so on) via an explicit **mapping table**.

Emit a report classifying every group:
- ✅ balances once the nominal leg is synthesised
- ⚠️ ambiguous — mapping unclear, needs a human decision
- ❌ cannot balance — a genuine v1 defect

**That report is the deliverable.** It is a mechanically-derived list of where v1's books
are wrong, and it feeds directly into the gap-closing Ian is already doing. Stage 1 has
value even if Stage 2 never runs.

### Stage 2 — Load
Recommended: an **opening-balance entry** as of a chosen date, then full detail forward
from there. Full-history detail loading of known-broken data is expensive and of
questionable value — but Stage 1 still analyses *all* history, so no findings are lost.

Rules: ETL never mutates Firestore (§11 rule 4); idempotent and re-runnable; everything
unmappable goes to a **quarantine table with a reason**, never silently coerced;
reconciliation report on every run (source count, target count, sums both sides).

---

## Before the next phase is planned — bible §3.6

**Phase 2 and Phase 3 each get a research pass before their plan is written.** Phase 1 was
planned from first principles and got away with it because double-entry is the most documented
structure in accounting. The next two are not like that:

| Phase | What to research first | Why it cannot be invented |
|---|---|---|
| ~~2 — source documents~~ | ✅ **DONE** — `docs/discovery/18-period-close.md` → **ADR-006**. Month close is a pure lock; year close posts one entry into 3300 via the existing `postEntry` | *(Correction: December needs **v1's** close, not ours. Per ADR-005 the old system closes 2026 — our first month-close is ~Feb 2027, our first year-close Dec 2027.)* |
| **3 — inventory** | Valuation method (weighted average vs FIFO vs standard) for food businesses; when COGS posts; wastage, spoilage and count-variance treatment; **inter-company transfer and elimination** | The commissary→branch pipeline is ~24 capabilities that double-count by construction if the elimination is wrong |

The first of these is already running (`docs/discovery/17-industry-erp-patterns.md`).

---

## H. Task sequence

| # | Task | Depends on |
|---|---|---|
| T-101 | Core schema: organizations, stores, persons, accounts, fiscal_periods | Phase 0 |
| T-102 | Chart of accounts seed + `legacy_code` mapping | T-101, **Ian's review** |
| T-103 | `journal_entries` + `journal_lines` + all constraint triggers | T-101 |
| ~~T-104~~ | ~~Constraint tests~~ — **ABSORBED BY T-103, 2026-08-23.** T-103 shipped 27 tests across all 19 invariants against real Postgres, proving the database refuses a single-leg entry, a zero-line entry, an unbalanced entry, a closed- or locked-period posting, a header or reserved account as a posting target, an edit or delete of a posted entry, and a duplicate idempotency key. Specifying T-104 separately would build duplicates | — |
| T-105 | Posting engine: `postEntry`, idempotency | T-103 |
| T-106 | `reverseEntry` + immutability enforcement | T-105 |
| T-107 | Builder adapter: in/out → debit/credit | T-105 |
| T-108 | Worked examples as fixtures | T-102 |
| T-109 | The ten invariants as CI tests | T-105 |
| T-110 | Reporting views | T-105 |
| T-111 | Property-based test suite | T-109 |
| T-112 | ETL framework + reconciliation reporter | T-103 |
| T-113 | Nominal-leg mapping table | **Ian's review** |
| T-114 | ETL Stage 1 — analysis mode + audit report | T-112, T-113 |
| ~~T-115~~ | ~~ETL Stage 2 — opening balance + detail load~~ — **CANCELLED 2026-08-24, bible row 106.** v2 assumes a zero starting point; no historical data is migrated at all. The books open with one balance-sheet entry of counted, present-day facts. **Loading 15,584 legs of known-broken history into clean books adds nothing when the point of the rebuild is that the new books are not the old ones** | — |
| T-116 | Trial-balance + GL screens (walking skeleton) | T-110 |

Each becomes a `docs/tasks/NNN-<slug>.md` spec (bible §3.3) before a Sonnet agent starts.
T-102 and T-113 gate on Ian and should go to him early.

---

## I. Risks

| Risk | Mitigation |
|---|---|
| Nominal-leg synthesis is ambiguous for some source types | Quarantine + Ian reviews; never guess a mapping |
| v1 data does not balance even on the balance-sheet side | Expected. Stage 1 quantifies it; that is a finding, not a blocker |
| Chart of accounts churns after Phase 2 starts | Accept some churn; `legacy_code` and codes are stable, names are cheap to change |
| Scope creep into source documents | The exit gate is explicit. Expenses and AP are Phase 2 |
| Deferred trigger performance on bulk ETL load | Batch inside one transaction; measure before optimising |

---

## J. Decisions needed from Ian

1. **Chart of accounts** (§B) — do the account names match how you think about the
   business? Anything missing, anything you would never use? *Blocks T-102.*
2. **Fiscal year** — calendar January–December? *Recommended: yes.*
3. **Opening-balance date for the detail load** (§G Stage 2) — suggest the start of the
   current fiscal year. Analysis still covers all history either way.
4. **Store-level P&L** — assumed **yes** (it drives `store_id` on every line). Confirm.
5. **Accrual basis** — v1 already runs AP and AR, so it is effectively accrual.
   *Recommended: state it explicitly and apply it consistently.*
