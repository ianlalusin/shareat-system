# T-211 — The manager/owner dashboard

> **Status:** ✅ **Built and smoketested, 2026-09-05.** `/` is the dashboard now; typecheck clean;
> unit 1012 passed / 1 skipped / 1 known-red (pre-existing DEF-170, unchanged by this task — 1014
> total); integration 91/91 files, 2312/2312 tests (includes T-217's +3); `npm run build` exit 0,
> dev server stopped first. Live-smoketested on 9008 signed in as a seeded manager: every tile
> renders a real figure over seeded data, the balance sheet tile ties (₱29,328.00, the same figure
> this project has quoted as proof of correctness since the balance sheet shipped), and every
> tile's link lands on the report it summarises. Not committed — commit is this session's own next
> step alongside T-217.
> **Depends on:** T-209a/b/c (balance sheet, AR/AP aging, cash flow —
> shipped), T-210 (sales rollup — shipped). Named in `docs/plans/phase-6-reporting-and-dashboards.md`
> Wave 2, and in `docs/plans/v2-completion-blueprint-2026-09-05.md` §2 as the single highest-value
> shell gap: `apps/erp/src/app/page.tsx` is still the Phase 0 scaffold, so 74 built feature pages are
> reachable only by typing a URL.

## Why this exists

Root `/` has never been touched since T-183 added one link to it. Every other screen in this app is
reachable only by knowing its route. `docs/discovery/26-reporting-dashboards-and-insights.md` §B.1/B.2
(live-probed against production Firestore, 2026-09-04) documents which of v1's dashboard panels are
real, used, and worth porting, and which are not:

- **Port, with evidence:** top financial KPIs (Sales/Expenses/Net Income, range-selectable — §B.1
  row 1), `dashboardSummary/live`'s three KPIs (Active Staff, AR/AP Outstanding, Pending Cash
  Requests — §B.1 row 3, **live query, never the increment mechanism** — §B.2 documents five
  separate fixes that one design choice needed), sales-by-channel (§B.1 row 7, reuses T-210).
- **Do not port:** the AI "Attention Today" rail (client-cached, AI-adjacent — out of this phase per
  the plan's own exclusion list), Manager Tasks open count (no v2 analog exists; not invented here),
  any `FieldValue.increment`-shaped mechanism (§1.1's standing rule, restated for dashboards
  specifically per ianla-25's 2026-09-05 note — every dashboard tile is a live query, no exception
  for "it's just a count").
- **Added beyond v1, because it's free and it's the single most reassuring thing this app can show
  a manager:** a Balance Sheet snapshot (assets / liabilities+equity / ties), reusing
  `getBalanceSheet` verbatim — the exact invariant already proven live this project (assets =
  liabilities + equity, to the centavo).
- **Added, because the underlying engines are real and already used** (findings: 441 resolved at
  two v1 stores per discovery §C.2; low stock has its own screen and nav entry): a findings-needing-
  attention count and a low-stock count, both linking through to their real screens.

## Goal

Visiting `/` while signed in as an admin/manager shows a genuinely useful, live snapshot: this
period's Sales/Expenses/Net Income, whether the books tie today, AR/AP outstanding, cash-request
floats still open, active staff, findings needing attention, and low-stock items — each a link to
its full report, each computed by calling the SAME named query function its report page calls,
never a second definition of the same figure. No tile is a stored counter, a cache, or a realtime
listener.

## Scope — files this task may create or modify

**New:**
- `apps/erp/src/components/dashboard/Tile.tsx` — one presentational KPI tile (label, figure, basis
  caption, optional link)
- `apps/erp/src/components/dashboard/RangeForm.tsx` — the from/to date form for the P&L tile

**Modify:**
- `apps/erp/src/app/page.tsx` — replaces the Phase 0 scaffold with the dashboard. Keep it a real
  page component (not a redirect to `/dashboard`) — `/` is where the "Shareat" nav logo already
  points, and the blueprint's own framing is that root itself is the gap.
- `apps/erp/src/components/nav.tsx` — add a "Dashboard" entry at the very front of the "Daily" group
  pointing at `/`. **Check for a concurrent editor of this file first** (bible §3.4) — it has a
  history of two tasks needing it the same day (T-202/T-203).

**Do not touch:** any `packages/domain/src/reports/*`, `packages/db/src/repo/reports.ts`,
`findings.ts`, `low-stock.ts`, `employment.ts`, `cash-requests.ts`, `money-accounts.ts` — every
figure on this page is an existing, tested query. This task is a presentation layer over data that
already exists, not a new query surface. `apps/erp/src/app/sign-in/page.tsx`'s post-login redirect
(currently `/sales-days`) is explicitly **out of scope** — see Open questions.

## Contract

### 1. Gate

`reportScope('/', 'view_financial_reports', sp.store)` — the same gate every `/reports/*` page
uses. This restricts the dashboard to `super_admin`/`admin`/`manager` (matrix: `staff: false`),
which matches v1's own framing ("the manager/owner dashboard") and this app's only existing
precedent for gating a cross-cutting financial view. A plain staff role signing in still lands
wherever `/sign-in` already sends them today (unchanged — see Scope) and never reaches `/`.

### 2. Tiles and their exact source

| Tile | Call | Scope | Basis shown |
|---|---|---|---|
| Sales · Expenses · Net income | `getIncomeStatement(tx, { orgId, storeId: scope.storeId ?? null, fromDate, toDate })` | range-selectable, default month-to-date | "revenue / operating expenses / net income, `fromDate`–`toDate`" |
| Balance sheet ties | `getBalanceSheet(tx, { orgId, storeId: scope.storeId ?? null, asOfDate: today })` | as of today | assets total, ties boolean — reuse `TieIndicator`-style colouring, don't reinvent it |
| AR outstanding | `getArAgingReport(tx, { orgId, storeId: scope.storeId ?? null, asOfDate: today }).totals.total` | as of today | links to `/reports/ar-aging` |
| AP outstanding | `getApAgingReport(tx, { orgId, storeId: scope.storeId ?? null, asOfDate: today }).totals.total` | as of today | links to `/reports/ap-aging` |
| Active staff | `employmentRepo.listActiveRoster(tx, storeId)` per store in `scope.stores` (or just `scope.storeId` if set), length summed | right now | links to `/staff` |
| Cash-request floats open | `cashRequestsRepo.openFloats(tx, orgId)`, filtered to `scope.stores` ids, length | right now | links to `/cash-requests` |
| Findings needing attention | `findingsFor(orgId, lastCompletedPeriod())` (reuse `apps/erp/src/app/findings/lib.ts` verbatim), count of `severity === 'hard'` | for `lastCompletedPeriod()` | links to `/findings` |
| Low stock | `lowStockRepo.lowStock(tx, orgId, storeId)` per store in scope, length summed | right now | links to `/inventory/low-stock` |
| Sales by channel | `getSalesRollup`'s `channels` grouping (T-210), same range as the P&L tile | same range as P&L | small table, not a chart — no charting library exists in this repo, don't add one for this task |

⚠️ **`Active staff` and `Low stock` need a per-store loop when `scope.storeId` is undefined**
(org-wide view) — same pattern `store-comparison/page.tsx` already uses for its own per-store
authorize loop. Do not add a new aggregate SQL query to avoid the loop; these repo functions are
already store-scoped by design and looping them for 1-5 stores is cheap (discovery §B.5: 14-127
docs/store for the comparable `salesDays` query).

### 3. Range selector

Same shape as `/reports/income-statement`: `?from=&to=&store=`, defaulting to first-of-month→today.
Reuse `ReportFilters`/`ReportBasis` components if their props fit; do not fork them for a one-page
difference.

### 4. No incompleteness flag needed

v1's cash-tile cap (`limit(500)`) existed because Firestore-side aggregation was expensive; every
figure here is a Postgres aggregate over the org's own rows with no artificial LIMIT, so there is
nothing to cap and nothing to flag as incomplete. State the basis (range/as-of/right-now) instead —
that is the honest equivalent for a query that is never capped.

## Invariants

1. Every money figure on this page is produced by calling the identical function its own report
   page calls — `grep` for a second income-statement/balance-sheet/aging calculation on this page
   must return nothing.
2. No `FieldValue.increment`-shaped table, no client cache, no realtime listener, anywhere on this
   page.
3. `dynamic = 'force-dynamic'` (same reasoning as every other report page — this reads the session).
4. A person without `view_financial_reports` never sees this page's data (RLS + `authorize()`, not
   a hidden tile).

## Tests

No new domain/repo tests — every query this page calls is already covered by its own report's test
suite (T-209a/b/c, T-210). Smoketest live on 9008: sign in as an admin/manager, confirm every tile
renders a real number against seeded data and every link lands on the report it claims to summarise.
`ListAgents` first — do not run `npm run build` / `npm run test:integration` beside a busy peer on
the shared `shareat_test` DB.

## Out of scope — with reasons

**Charts/graphs** — no charting library in this repo; a table of the same numbers is not a
regression, it's the honest version of "no counter, no cache." **The AI Attention Today rail** —
explicitly excluded by the phase-6 plan this task inherits from. **Changing `/sign-in`'s default
post-login redirect** — a decision about every role's landing page, not just the manager/owner one;
flagged for Ian, not decided here. **Per-role dashboard variants** — v1 has one dashboard; so does
this.

## Open questions

- Should `/sign-in`'s default redirect move from `/sales-days` to `/` now that `/` is real? Only for
  roles that pass `view_financial_reports` — staff would still need a different default. Flagging
  for Ian rather than deciding it inside this task.
- **Found live-smoketesting, not a bug:** the "Expenses" tile (`costOfSales + operatingExpenses`)
  can render NEGATIVE over a short date range at the org-wide scope — confirmed on seeded dev data,
  `2026-09-01`–`2026-09-05`: cost of sales alone is **-₱2,320.00** because `5175 Cost transferred to
  branches` (a commissary→branch transfer) is a large contra entry, so the combined figure reads
  -₱840.00 even though it matches `/reports/income-statement`'s own totals exactly (verified byte
  for byte). Honest, not a display bug — flagging in case Ian wants Sales/Cost of sales/Operating
  expenses/Net income as four separate tiles instead of three, specifically so a contra entry never
  reads as a negative "Expenses".

## Done when

- [x] `typecheck` clean.
- [x] `npm test` clean, no regressions — 1012 passed / 1 skipped / 1 known-red (pre-existing
      DEF-170), unchanged by this task.
- [x] `npm run test:integration` green — 91/91 files, 2312/2312 tests, real Postgres.
- [x] `npm run build` succeeds with the dev server stopped first — exit 0.
- [x] Smoketested live on 9008 — every tile renders a real figure, balance sheet ties, every link
      lands on the right report.
- [x] Self-reviewed line by line.
- [ ] `docs/ROADMAP.html` T-211 row updated — next step, after this file's own commit.
- [x] This file's status line updated.
