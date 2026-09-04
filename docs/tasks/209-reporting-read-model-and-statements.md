# T-209 — the reporting read model and the completed statement set

Status: **T-209a done — 2026-09-05.** Gates: typecheck clean · unit 1013/1014 (1 pre-existing
skip, unrelated) · full integration suite, 84 files / 2262 tests, green · `npm run build` exit 0
(dev server confirmed stopped first) · live-smoketested on 9008 (signed in as super-admin, real
dev data: rendered, tied, store/as-of/year-close filters round-tripped through the URL, empty
state confirmed for a pre-activity date). T-209b/c not started.
Full contract per `docs/plans/phase-6-reporting-and-dashboards.md` §7 Wave 1: balance sheet and
AR/AP aging first (ADR-005's January subset — the 15 Nov go/no-go is judged partly on these), then
cash flow, per-store P&L comparison, drill-down from a report line to its journal entries, and one
shared CSV export path. Sliced the same way T-189 and T-207/T-208 were, because the full contract
is too large for one sitting and the January-critical half (balance sheet + AR/AP aging) should not
wait on the rest:

| Slice | Scope | State |
|---|---|---|
| **T-209a** | The balance sheet | **this session** |
| **T-209b** | AR aging + AP aging reports, reconciled to their control accounts | not started |
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
