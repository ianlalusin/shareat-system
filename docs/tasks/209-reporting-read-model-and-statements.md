# T-209 — the reporting read model and the completed statement set

Status: **T-209a done — 2026-09-05.** **T-209b done — 2026-09-05.** Gates: typecheck clean · unit
1013/1014 (1 pre-existing skip, unrelated) · full integration suite, 86 files / 2274 tests, green ·
`npm run build` exit 0 (dev server confirmed stopped first) · both screens live-smoketested on
9008 against real dev data: AP aging renders the correct empty state (the dev org has zero open
payables) with `Reconciles ₱0.00 = ₱0.00`; AR aging renders three real open charges totalling
₱3,220.00, reconciling exactly to the 1210 control balance; the store filter round-tripped through
the URL and re-reconciled after narrowing to one store. **T-209c done — 2026-09-05.** Gates:
typecheck clean · unit 1012/1014 (1 pre-existing skip + 1 pre-existing, already-diagnosed red —
DEF-170, unrelated attendance golden-corpus divergences landed by a concurrent session, not this
task) · full integration suite 88 files / 2283 tests, 2282 passing (the 1 failure was a timing-
sensitive flake in an unrelated file under real system memory pressure — confirmed non-regression
by isolated re-run, logged as DEF-171) · `npm run build` exit 0 (dev server stopped first) ·
live-smoketested on 9008 as admin (Lipa): cash flow and store comparison rendered real, non-trivial
dev-org figures and reconciled exactly; the trial-balance → journal-lines drill-down round-tripped
with totals matching the source line to the centavo, including a correctly-flagged reversed entry;
CSV export confirmed server-side (clean `200`s in the dev server log; the browser sandbox blocks
the actual file save, which is expected and unrelated to the route's correctness).
Full contract per `docs/plans/phase-6-reporting-and-dashboards.md` §7 Wave 1: balance sheet and
AR/AP aging first (ADR-005's January subset — the 15 Nov go/no-go is judged partly on these), then
cash flow, per-store P&L comparison, drill-down from a report line to its journal entries, and one
shared CSV export path. Sliced the same way T-189 and T-207/T-208 were, because the full contract
is too large for one sitting and the January-critical half (balance sheet + AR/AP aging) should not
wait on the rest:

| Slice | Scope | State |
|---|---|---|
| **T-209a** | The balance sheet | done — 2026-09-05 |
| **T-209b** | AR aging + AP aging reports, reconciled to their control accounts | **this session** |
| **T-209c** | Cash flow, per-store P&L comparison, drill-down to source entries, CSV export | done — 2026-09-05 |

## Goal

`apps/erp/src/app/reports/` has trial balance and income statement (T-110) and nothing else.
Phase 1's own plan (`docs/plans/phase-1-accounting-spine.md` §E) named `v_balance_sheet` as one of
five intended reporting views; T-110 built three of the five. This slice builds the fourth, and it
is the one ADR-005 actually dates: bible §10's Phase 3 exit-gate line and the phase-6 plan agree the
balance sheet is January-critical, not a nice-to-have.

## Scope (T-209a)

- `packages/db/schema/views.ts` — new `vBalanceSheet` view, added to the file's existing top-comment
  block (not a separate block) since it is the same family as the other three.
- `packages/db/migrations/0128_t209_balance_sheet_view.sql` — hand-written (DEF-073 is still open;
  `db:generate` remains unusable). `meta/_journal.json` gets a matching entry.
- `packages/db/src/cutover/classification.ts` — `v_balance_sheet` added to `NON_TABLE_RELATIONS`,
  same as its three siblings.
- `packages/db/src/repo/reports.ts` — new `getBalanceSheetLines`, mirroring `getIncomeStatementLines`
  exactly (same `DateRangeFilter`, same re-aggregation shape).
- `packages/domain/src/reports/balance-sheet.ts` — new `getBalanceSheet`, mirroring
  `getIncomeStatement`'s file structure and its `basis` field.
- `apps/erp/src/app/reports/balance-sheet/page.tsx` — new screen, mirroring the trial-balance and
  income-statement pages' use of `reportScope`/`runReport`.
- `apps/erp/src/components/reports/BalanceSheetTable.tsx` — new, alongside the existing
  `TrialBalanceTable`/`IncomeStatementTable`.
- `packages/domain/tests/integration/balance-sheet.test.ts` — new.

## Contract

`getBalanceSheet(ex, { orgId, storeId?, asOfDate, includeYearClose? })` returns:

```ts
{
  assetLines: BalanceSheetLine[]; assets: Money;
  liabilityLines: BalanceSheetLine[]; liabilities: Money;
  equityLines: BalanceSheetLine[]; equity: Money;
  /** assets == liabilities + equity, asserted — bible §10's "with the accounting equation
   *  asserted", rendered rather than only tested. */
  ties: boolean;
  basis: { orgId; storeId; asOfDate; includeYearClose };
}
```

A balance sheet is a snapshot, not a range — `asOfDate` is the only date the caller supplies.
Internally this becomes `fromDate: EARLIEST_POSSIBLE_DATE, toDate: asOfDate` against the same
`DateRangeFilter` shape `getTrialBalance`/`getIncomeStatement` already use, because bible row 106
means there is never real data before an org's own creation — no separate "inception date" concept
is needed. `includeYearClose` defaults to `true`, matching the trial balance's own default and
reasoning (ADR-006: a balance-sheet-style view includes the year-close entry by default).

### ⛔ The one thing this task exists to get right: how the total is computed

**`v_balance_sheet`'s `net_amount` is signed by the account's TYPE, uniformly — never by the
account's own `normal_balance`.** This mirrors `v_income_statement`, not `v_trial_balance` /
`v_account_balance`, and the reason is the same reason in both places: three seeded accounts are
contra accounts whose `normal_balance` deliberately disagrees with their type (1590 accumulated
depreciation: type=asset/normal_balance=**credit**; 4900/4950: type=income/normal_balance=**debit**,
not relevant to THIS view but the same failure mode). A balance sheet's "total assets" must
subtract accumulated depreciation from gross PP&E, which only happens if 1590's contribution is
signed by the ASSET convention (debit − credit — giving a negative number, since 1590 carries a
credit balance) rather than by its own normal-balance convention (credit − debit — giving a
*positive* number that would be **added** to gross assets instead of subtracted).

⭐ **This is not a hypothetical worry — it is a bug this project already shipped once and caught.**
`docs/tasks/111-property-based-invariant-tests.md` built a property test of the analogous "extended
accounting equation" and its first draft made exactly this mistake: it grouped by account type but
summed each row's own `normal_balance`-signed `balance`, and a two-line entry touching 4900 failed
an equation that was never actually wrong. `v_balance_sheet` is deliberately built the
`v_income_statement` way from the start, not the way T-111's first draft was, so this task does not
re-discover the same defect a second time.

## Invariants

Bible §10 (Phase 1 exit gate, item 4): *"`v_balance_sheet` — 1000-3000, with the accounting equation
asserted."* Bible §16.1 invariant 9 (Assets = Liabilities + Equity, continuously) — this screen is
where invariant 9 is finally *rendered*, not only tested (T-111 tests it against random data;
nothing until now has shown it to a person on a real books). Phase-6 plan §9 item 1: *"A balance
sheet, an income statement and a trial balance render for the same date range, and they tie."*
Phase-6 plan §2.1: no second definition of "total assets" anywhere else — the dashboard (T-211,
later) must call this same function, never re-derive the figure.

## Tests

- `packages/domain/tests/integration/balance-sheet.test.ts` — posts real entries through
  `postEntry` (including one touching `1590` to prove the contra case), asserts:
  - `ties === true` after each posting, matching T-111's "continuously" discipline where practical;
  - a debit to `1590` REDUCES `assets`, not increases it (the regression test for the bug named
    above);
  - `assets`, `liabilities`, `equity` each equal the sum of their own `*Lines`;
  - an account with zero net activity in range is absent from its list (same "no row ≠ zero
    balance" distinction `getTrialBalance` already documents);
  - `includeYearClose: false` excludes the year-close entry's effect, `true` (the default)
    includes it.

## Out of scope

- AR/AP aging, cash flow, per-store P&L comparison, drill-down, CSV export — T-209b/T-209c.
- Sub-grouping assets into "current" vs "fixed" or similar presentation tiers — the exit gate needs
  the equation to render and tie, not a particular layout. Matches trial balance's own flat-list
  precedent; can be revisited if Ian asks for it on the built screen.
- A `view_balance_sheet` capability — reuses `view_trial_balance` (org-scoped, admin/super_admin
  only), because a balance sheet is the same audience and sensitivity as the trial balance it
  extends, not a store-operational report like the income statement.

## Done when

- [x] `vBalanceSheet` declared in `views.ts`, migration 0128 applied, journal entry added.
- [x] `v_balance_sheet` added to `NON_TABLE_RELATIONS`.
- [x] `getBalanceSheetLines` (repo) and `getBalanceSheet` (domain) written and tested.
- [x] `/reports/balance-sheet` renders, gated by `view_trial_balance` via `reportScope`.
- [x] The contra-account regression test (a debit to 1590 reduces `assets`) is green.
- [x] typecheck clean · unit tests pass · full integration suite green · `npm run build` exit 0
  (dev server stopped first) · smoketested live on 9008.
- [x] `docs/ROADMAP.html` and `docs/plans/phase-6-reporting-and-dashboards.md` updated to reflect
  T-209a shipped, T-209b/c still open.
- [x] Nav entry added (`Reports → Balance sheet`) — this repo's own history (DEF-139) is a shipped,
  tested screen with no nav entry, reachable only by typing the URL.

---

## T-209b — AR aging and AP aging

### Goal

ADR-005's January subset names *"trial balance · P&L · balance sheet · AR and AP aging"*. T-209a
shipped the balance sheet; this is the other half. `apRepo.aging()`/`arRepo.aging()` (T-130/T-131)
already bucket every open item by due date, falling back to invoice/charge date — the math exists.
What is missing is the **report**: a total, a reconciliation to the control account, and a screen.

### ⛔ The one thing this task exists to get right: reconciliation, not just a bucketed list

A row-per-party aging table that never foots to anything is a list, not a report. Phase-6 plan §9
item 2 names the exit condition explicitly: *"The AP and AR aging reports foot to their control
accounts — `2110` and `1210` — with no tolerance."* `apRepo.aging()`/`arRepo.aging()` derive
"outstanding" from the **subledger** (`expenses`/`supplier_invoices`/`expense_payments`/
`ap_payment_allocations` for AP; `ar_charges`/`ar_collection_allocations`/`ar_write_offs` for AR).
The control balance comes from a **second, independent path**: summing `journal_lines` directly
against `a.code = '2110'`/`'1210'`, the same query shape `apRepo.positionOf`/`arRepo.positionOf`
already use per-party, widened to every party. These two paths share no code, so agreement between
them is a real check, not a tautology — exactly the same reasoning invariant 6 already states for a
single party, extended to the whole register. **No tolerance**: `Money.equals()`, not a
0.005-epsilon float comparison — this codebase has exact centavos, so "close enough" has no meaning
here the way it does for a legacy-float import.

### Scope

- `packages/db/src/repo/ap.ts` — new `orgAgingTotal(tx, orgId, storeId?)`, mirroring `positionOf`
  exactly minus the `party_id` filter (same query shape, same `AP_CONTROL_CODE`).
- `packages/db/src/repo/ar.ts` — new `orgAgingTotal(tx, orgId, storeId?)`, the `AR_CONTROL_CODE`
  mirror.
- `packages/domain/src/reports/ap-aging.ts` — new `getApAgingReport(tx, { orgId, storeId?, asOfDate })`.
- `packages/domain/src/reports/ar-aging.ts` — new `getArAgingReport(tx, { orgId, storeId?, asOfDate })`.
  ⚠️ Both take `Tx`, not `Executor` — they call `apRepo`/`arRepo` functions directly (Tx-typed, same
  as `packages/domain/src/ap/index.ts` and `ar/index.ts` already do), unlike `getBalanceSheet`/
  `getIncomeStatement`, which only ever touch `reportsRepo` (`Executor`-typed).
- `packages/domain/src/index.ts` — export the two new report modules.
- `apps/erp/src/app/reports/ap-aging/page.tsx`, `apps/erp/src/app/reports/ar-aging/page.tsx` — new
  screens, mirroring the balance sheet's use of `reportScope`/`runReport`, but gated by
  `view_financial_reports` (store-scoped) rather than `view_trial_balance` — an aging register is
  the income statement's audience (a store manager needs to know who they owe / who owes them), not
  the trial balance's admin-only one.
- `apps/erp/src/components/reports/ApAgingTable.tsx`, `ArAgingTable.tsx` — new, alongside
  `BalanceSheetTable`/`IncomeStatementTable`/`TrialBalanceTable`. Each renders its own
  reconciliation indicator (a local variant, same reasoning `BalanceSheetTieIndicator` gives for not
  reusing the shared `TieIndicator` — "aging total = control account" is the sentence this screen
  needs, not "total debits = total credits").
- `apps/erp/src/components/reports/AgingFilters.tsx` — new, shared by both screens (store + as-of
  date only — no year-close toggle: AR/AP control accounts are never touched by a year-close entry).
- `apps/erp/src/app/ap/lib.ts`, `apps/erp/src/app/customers/lib.ts` (or a shared reports lib) —
  party-name resolution for the report rows, same map-join pattern `listSuppliersWithPosition`
  already uses. The domain layer returns bare `supplierId`/`customerId`; name-joining is a
  presentation concern, same precedent as the supplier/customer registers.
- `apps/erp/src/components/nav.tsx` — `Reports → AP aging` and `Reports → AR aging`, alongside the
  existing three (DEF-139 precedent: a shipped, untested-by-nav screen is reachable only by URL).
- `packages/domain/tests/integration/ap-aging.test.ts`, `ar-aging.test.ts` — new.

### Contract

`getApAgingReport(tx, { orgId, storeId?, asOfDate })` returns:

```ts
{
  rows: { supplierId: string; storeId: string; current: Money; d1to30: Money; d31to60: Money;
          d61to90: Money; d90plus: Money; total: Money }[];
  totals: { current: Money; d1to30: Money; d31to60: Money; d61to90: Money; d90plus: Money; total: Money };
  controlBalance: Money;
  /** totals.total === controlBalance, to the centavo — the exit-gate condition, rendered. */
  reconciles: boolean;
  basis: { orgId: string; storeId: string | null; asOfDate: string };
}
```

`getArAgingReport` is the same shape with `customerId` in place of `supplierId`. Both are snapshots
("as of" one date, like the balance sheet, not a range) — `apRepo.aging()`/`arRepo.aging()` already
buckets against `asOfDate` internally; the domain layer adds nothing but the total, the control
balance, and `reconciles`. A party with a total but no row-level bucket that sums to it is
impossible by construction (`total` is derived from the same buckets shown, same discipline
`getBalanceSheet` uses for its section totals) — the only thing that can disagree is
`totals.total` vs. `controlBalance`, which is the one comparison this task exists to make visible.

### Invariants

Bible §16.1 invariant 6 (a control account's subledger sums to its balance) — this screen is where
invariant 6 is *rendered* for the WHOLE register, not only per-party (⭐ `findings.ts`'s
`unpartiedControlLines` already catches the party-less-line failure mode; this is the sum-level
check, a different failure mode: every line has a party, but the two aggregation paths still
disagree). Phase-6 plan §9 item 2 (the exit-gate line this task closes) and §2.1 (one query per
figure — `totals` is derived from `rows`, never a third independent SQL statement re-summing
`expenses`/`ar_charges`).

### Tests

- `packages/domain/tests/integration/ap-aging.test.ts` — posts a credit expense with a `dueDate`
  through the real `recordInvoice`/`verifyInvoice`/`recordExpenseForInvoice` flow (same fixture
  shape `ap.test.ts`'s own aging test already uses), asserts:
  - `reconciles === true` after a normal posting;
  - the bucket a 45-day-old item lands in matches `apRepo.aging()`'s own existing test
    (31-60, not current);
  - `totals.total` equals the sum of every row's `total`, which equals the sum of every bucket
    column across rows;
  - a partial payment reduces both `totals.total` AND `controlBalance` together (proving the two
    independent paths move in lockstep, not just agree at zero);
  - `storeId` narrows both the rows AND the control balance to that store alone (T-130's
    "store-scoped, not org" rule, restated for a report instead of a single party).
- `packages/domain/tests/integration/ar-aging.test.ts` — the same shape, via `recordCharge`/
  `recordCollection`, mirroring `ar.test.ts`'s own fixtures.

### Out of scope

- Cash flow, per-store P&L comparison, drill-down, CSV export — T-209c.
- A combined "AR + AP" single screen — v1 and the phase-6 plan both treat these as two reports
  (different control accounts, different parties, different audiences on which side of the
  business they describe); nothing asked for one screen to merge them.
- A `receivingDisputeOverdue`-style age-based finding off the back of this data — that is T-213's
  detector, not this screen's job; this task renders the aging, it does not add a new `/findings`
  kind.
- Sub-bucketing beyond the five standard columns (current/1-30/31-60/61-90/90+) — matches
  `apRepo.aging()`/`arRepo.aging()`'s existing shape; a finer bucket would need new repo-level work
  this task does not do.

### Done when

- [x] `apRepo.orgAgingTotal`/`arRepo.orgAgingTotal` written and tested.
- [x] `getApAgingReport`/`getArAgingReport` written and tested, including the "moves in lockstep"
  reconciliation regression.
- [x] `/reports/ap-aging` and `/reports/ar-aging` render, gated by `view_financial_reports` via
  `reportScope`.
- [x] typecheck clean · unit tests pass · full integration suite green · `npm run build` exit 0
  (dev server stopped first) · smoketested live on 9008.
- [x] `docs/ROADMAP.html` and `docs/plans/phase-6-reporting-and-dashboards.md` updated to reflect
  T-209b shipped, T-209c still open.
- [x] Nav entries added (`Reports → AP aging`, `Reports → AR aging`).

---

## T-209c — cash flow, per-store P&L comparison, drill-down, CSV export

The last slice of T-209 — four smaller deliverables, none large enough to be its own task, all
extending infrastructure T-209a/b already built. Not ADR-005 January-critical (that gate closed
with T-209b); this is the rest of Phase 6 Wave 1.

### ⛔ The one thing this task exists to get right: the cash flow statement's method

No discovery pass or ADR names a cash-flow design — this task makes the call. **Indirect method,
computed entirely as balance-sheet-account DELTAS between two snapshots, reusing
`reportsRepo.getBalanceSheetLines` (already signed by account TYPE, exactly the convention this
needs) rather than any new per-transaction classification.**

Rejected alternative: classifying by each entry's `source_type` (30+ distinct values across the
domain layer — `sale`, `ap_payment`, `loan_disbursement`, `depreciation`, `production_void`, …).
A switch over 30+ strings that a new posting type can silently miss is exactly the "hand-maintained
classification list" shape bible §16.0/§4.2 rule 7 already rules out elsewhere — and this project
has no such list even for the P&L (`v_income_statement`'s `category` derives from the chart of
accounts' PARENT HEADER, never from `source_type`). Cash flow gets the same discipline: classify by
**account code**, not by transaction shape.

**Operating starts from net income, not from zero — income/expense accounts are entirely absent
from `v_balance_sheet`, so a pure cash sale (`Dr 1110 / Cr 4xxx`) has NO non-cash balance-sheet
account to carry its effect.** Verified by hand against four cases before writing a line of code
(a cash sale, a credit sale, a depreciation posting, a loan disbursement) — only the depreciation
add-back "falls out for free" from the account-delta method; net income itself does not, and a
first draft that omitted it would silently zero out every cash-generating transaction that never
touches a working-capital account. So:

```
operating  = netIncome(fromDate..toDate, same store/includeYearClose)
           + Σ non-cash balance-sheet account deltas bucketed "operating" (below)
investing  = Σ non-cash balance-sheet account deltas bucketed "investing"
financing  = Σ non-cash balance-sheet account deltas bucketed "financing"
```

**Why the account-delta terms still need no separate depreciation add-back, once net income is the
base:** `v_balance_sheet` signs `1590` (accumulated depreciation, a contra-asset) by TYPE — asset,
debit-positive — so as depreciation accrues, `1590`'s type-signed balance becomes MORE NEGATIVE.
Bucketing `1590` as an ordinary operating asset account and applying the universal rule below
produces a POSITIVE operating contribution automatically, which is arithmetically identical to the
textbook "add back depreciation expense" line: the expense already reduced `netIncome` above, and
the `1590` delta term exactly cancels that reduction because the posting is non-cash. Same reasoning
`getBalanceSheet` used for the "Current period earnings" line (T-209a) and
`getApAgingReport`/`getArAgingReport` used for `orgAgingTotal` (T-209b): find the shape that removes
the special case rather than the one that adds a line to manage it (bible row 118) — it just does
NOT extend to net income itself, which has no balance-sheet account to fall out of.

**The universal per-account delta rule** (`closing` / `opening` are each non-cash balance-sheet
account's TYPE-signed `netAmount` from `getBalanceSheetLines`, at `toDate` and
`addDays(fromDate, -1)` respectively, over the SAME `orgId`/`storeId`/`includeYearClose`):

- `type = 'asset'` → contribution = `-(closing - opening)` (an asset increase is a use of cash)
- `type = 'liability' | 'equity'` → contribution = `+(closing - opening)` (an increase is a source)

**Bucketing, by account code, for presentation only — the arithmetic above is identical in every
bucket:**

| Bucket | Codes | Reasoning |
|---|---|---|
| **Operating** | Every asset/liability/equity account not listed below | Working capital + the 1590 add-back, both fall out of the universal rule with no special case, added to `netIncome` above |
| **Investing** | `1510` (Property and equipment, gross) | Its own line so capex is visible; a disposal shows as the code's normal decrease, again with no special case |
| **Financing** | `2400` (Loans payable), `3100` (Owner's capital), `3200` (Owner's drawings) | External financing sources/uses. `3200` is debit-normal contra-equity — the universal equity rule (`+(closing-opening)`) already yields a NEGATIVE contribution as drawings accrue, because `getBalanceSheetLines` signs it credit-positive like every other equity account (T-209a's own contra convention, restated) |
| **Excluded from every bucket** | none — `3300`/`3900` are ordinary equity accounts under the universal rule, bucketed "operating" | `3900` is invariant-enforced to net to zero at rest (`findings.ts`'s `openingBalanceResidual`) — if it ever doesn't, the cash flow statement SURFACES that as a real operating-bucket figure instead of hiding it behind an exclusion. `3300` only moves at a year-close entry, which `includeYearClose` (default **false**, matching the income statement's own date-range default — ADR-006) excludes from both this delta calculation and the `netIncome` figure together, so no double-count is possible |

**The regression test this method exists to pass**: `operating + investing + financing` must equal
the actual change in cash & cash-equivalent accounts (`1110`,`1115`,`1120`,`1130`,`1140`) for the
same range, to the centavo — the cash-flow equivalent of T-209a's `ties` and T-209b's `reconciles`.
This is not asserted by construction the way those two were (a hand-picked bucket table could
still miss an account) — it is the actual proof the classification is complete, and if a future
account code is added to the chart without landing in exactly one bucket or the excluded set, this
test is what catches it.

### Scope

- `packages/db/src/repo/reports.ts` — new `getAccountEntries(ex, filter & { accountId })`: line-level
  detail (not aggregated) for ONE account, for the drill-down. `status in ('posted','reversed')`,
  matching every existing view's own filter, so the total shown on a drill-down screen never
  disagrees with the report line that linked to it.
- `packages/domain/src/reports/cash-flow.ts` — new `getCashFlow(ex, { orgId, storeId?, fromDate,
  toDate, includeYearClose? })`, per the design above.
- `packages/domain/src/reports/store-comparison.ts` — new `getStorePLComparison(ex, { orgId,
  storeIds, fromDate, toDate, includeYearClose? })`: calls `getIncomeStatement` once per store
  (Phase-6 plan §2.1 — no second definition of any P&L figure) and assembles the results side by
  side. No new repo function.
- `apps/erp/src/app/reports/cash-flow/page.tsx`, `apps/erp/src/app/reports/store-comparison/page.tsx`,
  `apps/erp/src/app/reports/journal-lines/page.tsx` — three new screens.
- `apps/erp/src/components/reports/CashFlowTable.tsx`, `StoreComparisonTable.tsx`,
  `JournalLinesTable.tsx`, `AccountDrillLink.tsx` (a small `<Link>` wrapper the account-row reports
  use to reach the drill-down with their own filter state carried over), `CsvExportLink.tsx`.
- `apps/erp/src/lib/csv.ts` — the ONE shared CSV formatting function (`toCsv`), covering quoting a
  value containing a comma, a quote, or a newline — the three cases a naive `join(',')` gets wrong.
- `apps/erp/src/app/reports/trial-balance/page.tsx`, `income-statement/page.tsx`,
  `balance-sheet/page.tsx` — add `AccountDrillLink` on each account row and `CsvExportLink` at the
  top, proving the two shared pieces work on an already-shipped screen, not only a new one.
- `apps/erp/src/components/nav.tsx` — `Reports → Cash flow`, `Reports → Store comparison`.
- `packages/domain/tests/integration/cash-flow.test.ts`, `store-comparison.test.ts` — new.

### Contract

```ts
getCashFlow(ex, { orgId, storeId?, fromDate, toDate, includeYearClose? }): Promise<{
  operatingLines: CashFlowLine[]; operating: Money;
  investingLines: CashFlowLine[]; investing: Money;
  financingLines: CashFlowLine[]; financing: Money;
  netChangeInCash: Money;              // operating + investing + financing
  actualCashChange: Money;             // the independent check: Δ(1110,1115,1120,1130,1140)
  reconciles: boolean;                 // netChangeInCash === actualCashChange, no tolerance
  basis: { orgId; storeId; fromDate; toDate; includeYearClose };
}>
```

`getStorePLComparison` returns `{ stores: { storeId; storeName; statement: IncomeStatementResult }[];
basis }` — literally `IncomeStatementResult` per store, never a re-derived figure (§2.1 again).

`getAccountEntries` returns one row per journal line: `{ entryId; entryDate; sourceType; sourceId;
status; memo; lineMemo; storeId; partyType; partyId; debit; credit }`, ordered by `entryDate`.

### Invariants

Bible §4.2 rule 7 (derived data is a view or a live query, never a maintained summary) — cash flow
adds no table, only two calls to an existing view-backed query plus one to the income statement.
Phase-6 plan §2.1 (one query per figure) — `getStorePLComparison` and the drill-down both reuse
existing domain functions rather than re-deriving a P&L or a balance figure a second way. Phase-6
plan §9 item 9 pattern (extended here): cash flow's own reconciliation is rendered on screen, not
only tested, matching T-209a's `ties` and T-209b's `reconciles`.

### Tests

- `cash-flow.test.ts` — posts a spread of transactions (a sale, a credit expense, a depreciation
  entry touching `1590`, a loan disbursement, an owner drawing, an asset purchase to `1510`) and
  asserts: `reconciles === true`; the depreciation entry's effect appears as a positive operating
  contribution with NO separate "add-back" line item computed by the test (it falls out of the
  universal rule); the `1510` purchase appears under `investing`, negative; the loan disbursement
  and the owner's capital contribution appear under `financing`; a drawing appears under `financing`
  as negative; `includeYearClose: false` (the default) excludes a year-close entry's effect from
  BOTH `operating` and the net-income figure it starts from, so `reconciles` still holds across a
  year-close boundary crossing.
- `store-comparison.test.ts` — two stores with different revenue/expense, asserts each store's
  figures match calling `getIncomeStatement` directly for that store alone (the "never re-derive"
  proof), and that omitting a store from `storeIds` excludes it from the result without affecting
  the others' figures.
- Drill-down and CSV export are presentation-layer; covered by the existing report integration
  tests continuing to pass plus a manual live-smoketest (small, low-risk, high-churn surface —
  matches this codebase's existing precedent of not unit-testing JSX table components).

### Out of scope

- Retrofitting `AccountDrillLink` onto `/reports/ap-aging` and `/reports/ar-aging` — those tables
  are keyed by PARTY, not by account, so "drill down to this account's entries" needs a different
  query shape (this supplier's/customer's lines on the control account, which
  `apRepo.openItems`/`arRepo.openItems` already answer for the OPEN-item case; a full history view
  is a different, smaller task if Ian wants it). `CsvExportLink` has no such mismatch — a bucketed
  aging table is already flat rows, so it IS wired onto both (see Done when).
- A PDF/print export alongside CSV — CSV is the industry-standard, spreadsheet-round-trippable
  shape the phase-6 plan names; a second export format is unrequested scope.
- Drilling INTO a drill-down (viewing an entry's OTHER lines, not just the one on the queried
  account) — the current screen shows enough to identify the source document (date, source type,
  source id, memo); jumping to the source document's own screen by `sourceType`/`sourceId` would
  need a per-source-type router this task does not build.
- A dashboard tile for cash flow — that's T-211, and it will call `getCashFlow`, never re-derive it.

### Done when

- [x] `getAccountEntries` written; `/reports/journal-lines` renders and is linked from trial
  balance, income statement, and balance sheet.
- [x] `toCsv` written; `CsvExportLink` wired onto trial balance, income statement, balance sheet,
  AP/AR aging (all five report screens shipped so far), plus the two new screens this task adds.
- [x] `getStorePLComparison` written and tested; `/reports/store-comparison` renders.
- [x] `getCashFlow` written and tested, including the reconciliation regression across a mixed
  transaction set and across a year-close boundary.
- [x] typecheck clean · unit tests pass (1 pre-existing, already-diagnosed red — DEF-170, unrelated)
  · full integration suite green (1 pre-existing flake — DEF-171, unrelated, confirmed non-
  regression) · `npm run build` exit 0 (dev server stopped first) · smoketested live on 9008.
- [x] `docs/ROADMAP.html` and `docs/plans/phase-6-reporting-and-dashboards.md` updated to reflect
  T-209 fully shipped.
- [x] Nav entries added (`Reports → Cash flow`, `Reports → Store comparison`).
