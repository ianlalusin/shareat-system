# T-110 / T-116 — Reporting views, and the first screen anyone can look at

> **Status:** spec ready. **Depends on:** T-103, T-105, T-118 (all done).
> **Delivers:** Phase 1 exit-gate items **2, 3 and 8**.
> **Written by:** Opus planner, 2026-08-24. Bible §3.3 format.

## Goal

Make the ledger **legible**. Everything built so far is invisible — a spine, a harness, an audit
that prints to a terminal. This puts a trial balance and an income statement on a screen on
port 9008, backed by queries rather than by maintained summary tables.

Three exit-gate conditions land here:

| | |
|---|---|
| **2** | The trial balance ties — one query, debits = credits, at any moment |
| **3** | The income statement is a **query** (`GROUP BY account_type`), not a scan list. **A newly added P&L account appears automatically** |
| **8** | A trial-balance screen renders in the running app on port 9008 |

---

## The rule that shapes every line of this task

**Derived data is a view, never a maintained summary row** (bible §4.2 rule 7).

No `account_balances` table. No nightly rollup. No cache invalidated on write. Every figure here
is computed from `journal_lines` at read time. If that is ever too slow, the fix is an index or a
materialized view **refreshed inside the same transaction** — never a counter updated by
application code.

> This is not a preference. The audit run on 2026-08-24 found **34 of 115 v1 account balances
> disagreeing with v1's own maintained counters**. That is what maintained counters do: they drift,
> silently, while looking authoritative. **We are not building v1's most expensive defect again.**

---

## Scope

Create or modify **only**:

```
packages/db/schema/views.ts                    view definitions (Drizzle `pgView`)
packages/db/migrations/0010_*.sql              a NEW migration — see the DEF-039 warning
packages/db/src/repo/reports.ts                the ONLY place report SQL is written
packages/db/src/index.ts                       re-export
packages/domain/src/reports/trial-balance.ts   the service layer
packages/domain/src/reports/income-statement.ts
packages/domain/src/index.ts                   re-export
apps/erp/src/app/reports/trial-balance/page.tsx
apps/erp/src/app/reports/income-statement/page.tsx
apps/erp/src/components/reports/*.tsx          presentation only
packages/db/tests/integration/reports.test.ts
packages/domain/tests/integration/reports.test.ts
```

**Do not modify** `journal.ts`, `accounts.ts`, `fiscal-periods.ts`, the seed, `postEntry`,
`reverseEntry`, `packages/etl/**`, or `packages/etl-firestore/**`. Migrations `0000`–`0009` are
applied and are **never edited**.

**Do not touch `PROJECT_BIBLE.md`** — §14 reserves amendments to the planner. Report instead.

### ⚠️ DEF-039 — before generating the migration

`meta/_journal.json` has carried hand-picked `when` values. The migrator **sorts by `when` and
silently skips anything sorting earlier, exiting 0**. Generate `0010`, then **immediately** run
`packages/db/tests/migration-journal.test.ts`. Verify; do not assume.

---

## Contract

### 1. `v_account_balance` — the base view

One row per `(org_id, store_id, account_id, period_id)` with `debit_total`, `credit_total`, and
`net_balance` **signed by the account's `normal_balance`** — so a debit-normal account with more
debits reads positive, and so does a credit-normal account with more credits. **A reader should
never need to know an account's normal balance to interpret its sign.**

Only `status = 'posted'` and `status = 'reversed'` entries contribute. A `draft` entry is not an
assertion about anything and must never appear in a report.

> `reversed` entries **are** included, deliberately: the original and its reversal both remain in
> the ledger and net to zero (T-106 invariant 5). Excluding the original would leave the reversal
> unmatched and break the trial balance — the exact opposite of the intent.

### 2. `v_trial_balance` — and it must TIE

Per account: total debits, total credits, and the closing balance. Filterable by org, store, and
date range.

**The tie is the point.** `SUM(debit) = SUM(credit)` across the whole view, always, with no
tolerance and no rounding allowance. The database already guarantees it per entry; this proves it
holds in aggregate, which is the claim a trial balance actually makes.

### 3. `v_income_statement` — a query, never a list

`GROUP BY account_type` over `journal_lines` joined to `accounts`, restricted to `income` and
`expense` types, for a date range.

**No hardcoded account list anywhere.** Exit-gate condition 3 is precisely that a newly added P&L
account appears without a code change — and there is a test for it below, because this is exactly
the defect v1 has: its income statement is a hand-assembled scan list, so a new account is invisible
until someone remembers to add it (discovery `06` §1.4).

**Contra accounts subtract.** `4900` sales discounts and `4950` returns are debit-normal revenue
accounts; they must reduce revenue rather than inflate expense. Ian's rule from row 24 — *comps are
contra-revenue* — is a worked case, and it belongs in a test.

### 4. The year-close entry must be excludable

ADR-006 requires it: **a date-range P&L must be able to exclude the year-close entry; a
balance-sheet-as-of must include it.** The entry carries a distinct `source_type` (`year_close`).
Every view here is written knowing that, and the income statement excludes it by default.

GnuCash's own documentation concedes its identical feature breaks its own reports for exactly this
reason. **It costs one `WHERE` clause now and is a shipped, self-admitted bug if missed.**

### 5. The screens

Two pages under `/reports`, server components reading through the domain layer.

- **Trial balance** — account code, name, debits, credits, balance; totals row; **an explicit
  "ties / DOES NOT TIE" indicator that is impossible to miss.** If it ever does not tie, that is
  the most important fact on the screen and it must not be a subtle red number.
- **Income statement** — revenue (net of contra), cost of sales, gross profit, operating expenses,
  net income. Date-range selectable.
- **Both must state their basis**: the date range, which stores, and whether the year-close entry
  is included. A report that does not say what it covers is how a number gets quoted out of context.
- **Empty state matters.** With no data these render zeros and a plain "no entries for this range",
  never a crash or a blank page. It is the state Ian will see first.

Money is formatted at the edge only. **Never `toLocaleString` on the server** — bible landmine:
server-side locale formatting silently renders in UTC/`en-US`.

---

## Invariants the tests must prove

**Views — real Postgres**
1. `v_account_balance` signs by `normal_balance`: a debit-normal account with net debits is
   positive; a credit-normal account with net credits is positive.
2. `draft` entries contribute **nothing** to any view.
3. A `posted` entry and its reversal both appear and **net to exactly zero**.
4. `v_trial_balance` ties — `SUM(debit) = SUM(credit)` — across a fixture with entries in several
   stores, periods and accounts.
5. Store and date-range filters restrict correctly, and the trial balance **still ties within any
   filter**. *(A filter that breaks the tie is a filter that splits an entry across the boundary.)*
6. The trial balance ties over the **T-108 worked examples** as a corpus, not only over
   hand-made pairs.

**Income statement**
7. `GROUP BY account_type` returns income and expense totals for a range.
8. ⭐ **A newly inserted P&L account appears with no code change** — insert an account, post to it,
   assert it shows up. **This is exit-gate condition 3 and the defect v1 has.**
9. Contra-revenue (`4900`, `4950`) **reduces revenue**; it does not increase expense.
10. Net income = revenue − contra − COGS − opex, on a worked fixture with a known answer.
11. A `year_close` entry is **excluded by default** and **included when asked for**.

**Screens**
12. `/reports/trial-balance` renders in the running app with real data and shows the tie indicator.
13. `/reports/income-statement` renders and its totals match the service layer exactly.
14. Both render cleanly with **no data at all** — zeros and an empty-state message, no crash.

## Out of scope

Balance sheet · cash flow · drill-down from a report line to its entries · any export · charts ·
per-store P&L comparison · the ETL · any change to posting logic.

## Done when

- [ ] Migration `0010` applies cleanly; re-running is a no-op; `migration-journal.test.ts` **passes**.
- [ ] All 14 invariants pass against real Postgres.
- [ ] `npm run typecheck` clean · `test` · `test:integration` green (**every existing test still
      passes**) · `build` succeeds with the dev server stopped.
- [ ] ⭐ **Smoketested in the running app on 9008** — both pages opened in a browser, with data and
      without. *A green build and green tests have already shipped a dead app on this project once;
      this box is not tickable from a terminal.*
- [ ] No maintained summary table was created. Every figure is a view.
- [ ] Any spec defect **reported, not silently worked around**.

---

## Implementation notes — resolved 2026-08-24

**1. My invariant 10 was wrong, and the implementer was right to deviate.**

I wrote *"Net income = revenue − contra − COGS − opex"* and called it net income. **That is
OPERATING income.** The 7000-series — interest income, interest expense, other income — sits
*below* operating profit and still has to reach the bottom line. My formula would have silently
excluded every one of those postings from net income.

**That is this project's founding defect, reproduced for a different subset of accounts.** v1's
income statement is a hand-assembled scan list, so an account nobody remembered stays invisible;
my formula would have made 7000 invisible by arithmetic instead of by omission. Same outcome.

The implementation shows **two distinct lines** — `operatingIncome` (matching invariant 10 exactly,
so the test still pins the figure I specified) and `netIncome = operatingIncome + otherIncomeExpense`.
That is also the standard presentation, so the fix costs nothing and reads better. **Adopted as the
rule, not just accepted as this implementation's choice.**

**2. Invariant 6 referenced a task that does not exist — a real defect in this spec.**

It requires the trial balance to tie "over the **T-108 worked examples** as a corpus." **T-108 was
never built**: no `docs/tasks/108-*.md`, and `tests/worked-examples/` is an empty placeholder. This
spec does not even list T-108 as a dependency, so the reference was careless rather than a
sequencing error.

The implementer built its own multi-store, multi-period corpus, **stated the substitution at the
top of both test files**, and reported it. Correct on every count — the alternative was pretending
an empty directory satisfied the requirement.

**T-108 remains genuinely worth building** (exit-gate item 4 is *"every worked example posts exactly
the expected lines"*, and its scope — a canonical posting pattern per business event — is broader
than reporting fixtures). It stays open; this task's corpus does not replace it.

**3. Scope was exceeded in two places, both disclosed and both correct.**

`apps/erp` needed `@shareat/domain` wired into its `package.json`, `next.config.js`
(`transpilePackages`) and `tsconfig.json` — without it the pages cannot import the service layer at
all. And the two pages query `organizations`/`stores` directly for their filter pickers, there being
no repo file for either in Scope. Reported rather than done quietly, which is the whole point of
the rule.

**4. The zero-organizations branch is the one thing not proven live.** The classifier blocked a
`TRUNCATE` against `shareat_dev`, and the implementer respected the block rather than working
around it — the right call. The branch is a single type-checked `if (orgs.length === 0)` and the
database was confirmed empty before seeding, so the risk is low, but it is **unproven, not proven**.
