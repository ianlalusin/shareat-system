# T-209 — the reporting read model and the completed statement set

Status: **T-209a done — 2026-09-05.** **T-209b done — 2026-09-05.** Gates: typecheck clean · unit
1013/1014 (1 pre-existing skip, unrelated) · full integration suite, 86 files / 2274 tests, green ·
`npm run build` exit 0 (dev server confirmed stopped first) · both screens live-smoketested on
9008 against real dev data: AP aging renders the correct empty state (the dev org has zero open
payables) with `Reconciles ₱0.00 = ₱0.00`; AR aging renders three real open charges totalling
₱3,220.00, reconciling exactly to the 1210 control balance; the store filter round-tripped through
the URL and re-reconciled after narrowing to one store. T-209c not started.
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
| **T-209c** | Cash flow, per-store P&L comparison, drill-down to source entries, CSV export | not started |

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
