# T-213 — OIL wave 2: the operational detectors

> **Status:** implemented and tested green — 16/16 new integration tests (fire + stay-silent per
> detector) against real Postgres, plus the full pre-existing `findings.test.ts` suite (33/33)
> confirmed with no regressions from wiring 8 more detectors into `listFindings()`. Typecheck
> clean. Remaining before Definition of Done: smoketest `/findings` on 9008 (waiting on the shared
> dev server, in use by T-210) and `npm run build`. Extracted from
> `docs/plans/phase-6-reporting-and-dashboards.md` §5 (lines 280–309) and its Wave 3 sequencing row
> (line 412). Unblocked today — depends only on Phases 2–5, all shipped — and touches no file T-210
> has open.
> **Unifies with:** T-135 (`docs/tasks/135-integrity-findings.md`), which this wave extends. Same
> machine, same contract, new kinds.
> **DEF-172 filed alongside this task**: writing this wave's three date-comparing detectors
> (`salesDayUnposted`, `expenseCategoryUnpostable`, `advanceUnliquidated`) surfaced that four
> pre-existing T-135 detectors age a business date against bare `current_date`, which migration
> `0112`'s own comment names as a standing bible violation on a UTC server. This wave's own three
> use the correct `(now() at time zone 'Asia/Manila')::date` form; the pre-existing four are logged,
> not fixed — out of scope here.

## Why this is next

T-135 shipped 22 derived, read-only detectors feeding `/findings`. Phase 6's plan names eight more
that Phases 2–5 have *now made computable* — they could not have been written before those phases
landed their data (FIFO layers, `journal_lines` FK integrity, the POS usage pull). None of the
eight touch reporting/`reports.ts` or the sales rollup, so this runs cleanly alongside T-210.

## The contract — unchanged from T-135

Every detector is `(tx: Tx, orgId: string) => Promise<DetectedFinding[]>` in
`packages/db/src/repo/findings.ts`, matching the real current shape (not the phase-plan's
illustrative sketch, which shows `amount`/`drillTo` fields that do not exist in code):

```ts
export interface DetectedFinding {
  kind: string;
  key: string;          // stable identity, kind + what it's about — derived, never chosen
  storeId: string | null;
  severity: 'hard' | 'soft';
  detail: string;       // uses peso() — never hand-interpolate the ₱ sign, see file header
}
```

Wire each new function into the `detected` array in `packages/domain/src/findings/index.ts ::
listFindings()`, one line per detector, comment naming the task/row it closes — that file is a
flat list on purpose; do not refactor it into a registry as part of this task.

- **No sweep, no cron, no stored state.** One SQL statement, run on read. A finding clears when
  its query stops returning the row.
- **Per-store thresholds that default in code and can never disable detection** — v1's rule,
  already an invariant here (T-135 restates it for a reason: a misconfigured store must not go
  silent).
- **Resolved:** no per-store threshold/config table exists for this feature, and every one of
  T-135's 22 existing detectors takes its threshold as a function parameter with a code default
  (`thresholdDays = 30`, etc.) rather than reading per-store config — same pattern here for all
  eight. No schema addition needed for this task.

## The eight detectors — corrected against the real schema

Reading `packages/db/schema/expenses.ts`, `suppliers.ts`, `sales-days.ts`, `stock-layers.ts` and
`stock-usage.ts` directly (not just the phase-6 plan's one-line sketches) changed two of the
eight before any code was written — logged here rather than discovered mid-implementation.

| Kind | Fires when | Ledger/table it reads | Note |
|---|---|---|---|
| `salesDayUnposted` | A `sales_days` row with `posSourced = true`, `status` in `('open','submitted')`, `businessDate` older than N days | `sales_days` | Simpler than the plan assumed: `posSourced`/`status`/`journalEntryId` already say everything, no mirror-collection filter needed |
| ⚠️ `expenseCategoryUnpostable` *(was `expenseMissingCategory`)* | An `expenses` row in `status='draft'`, older than N days, whose `category_id` resolves to an `expense_categories` row with `account_code IS NULL` | `expenses` ⋈ `expense_categories` | **Corrected.** `expenses.category_id` is `NOT NULL` (T-130) — "missing category" cannot exist at all. What v1's materiality-gated sweep is really standing in for now is a draft stuck because its category has no account mapped (invariant 7 blocks posting) — that's the live, derivable condition |
| ⚠️ `expenseInvoiceVoidedAfterLink` *(was `orphanExpense`)* | A non-voided `expenses` row whose linked `supplier_invoices.status` is `'voided'` | `expenses` ⋈ `supplier_invoices` | **Corrected.** `supplier_invoices_id` is `NOT NULL` and DB-enforced verified-at-insert (`expenses_require_verified_invoice` trigger) — an expense can never lack an invoice. But `supplier_invoices.status` CAN move to `'voided'` **after** an expense already links it (the void-cascade design deliberately keeps the verified stamp as history rather than clearing it) — so the real orphan condition is a link surviving its evidence being voided out from under it, read live, not at insert time |
| ⭐ `receiptPriceSpike` | A `delivery_lines.unit_cost` exceeds the trailing-N-receipt median for that `item_id` by X% | `delivery_lines` ⋈ `deliveries` | One window function (`percentile_cont(...) OVER (PARTITION BY item_id ...)`) — no baseline table to maintain or drift |
| `newVendorFirstPurchase` | A `deliveries` row with `kind='supplier'` whose `supplier_id` has no earlier `received` delivery | `deliveries` | `NOT EXISTS` over prior receipts for the same supplier |
| `advanceUnliquidated` | A per-party balance on account `1230` (debit − credit across `journal_lines`) that is nonzero and has been open past N days | `journal_lines` ⋈ `accounts` (code `1230`) | Confirmed genuinely non-duplicate: `docs/POSTING-PATTERNS.md` shows `1230` is also debited by salary advances and till-shift shortages, neither of which is a `cash_requests` row — `cashRequestFloatAgeing` only sees the one document type. **Extend the account-level view; do not touch the existing detector** |
| ⚠️ `usageRecordMissing` | A `verified` `sales_days` row for a store with **no active `pos_item_maps`** and **zero** `stock_usage_records` rows (`kind='usage'`) for that store + business date | `sales_days`, `pos_item_maps`, `stock_usage_records` | **Corrected.** `departments` (`stock-locations.ts`) is a flat org-wide list with no store roster and no store↔department linking table — a "which departments does this store have" check cannot be built from the current schema, so "department-aware" is read as "the manual-usage path" rather than invented per-department completeness. This is exactly `posUsagePullNotRun`'s uncovered complement: that detector's own `exists (... pos_item_maps ... status='active')` gate means a manual-only store with a verified day and literally zero usage records goes unseen today. Confirmed non-duplicate by construction — the two `exists`/`not exists` gates on `pos_item_maps` are mirror images |
| `meatSlabStale` | An open (`remaining_quantity > 0`) `stock_layers` row for an item with `kind='meat_slab'`, older than N days by `received_at` | `stock_layers` ⋈ `items` | A join, now that layers exist to age |

## Tests — T-135's invariant, applied to each of the eight

Per detector: one integration test that makes the condition true and proves the detector fires,
and one proving it stays silent when the condition does not hold (T-135 invariants 1–2). Against
real Postgres — no mock. If a detector needs a fixture Phase 2–5's tests don't already build,
write the minimal one; do not import a whole seed script for one row.

## Explicitly out of scope for this task

- The scorecard (T-214) — depends on this shipping first, not part of it.
- Wiring a `drillTo` route per kind — the current screen doesn't render one; adding that
  mechanism, if wanted, is a `/findings` UI task, not a detector task.
- Any schema/migration for per-store thresholds beyond a plain code constant, **unless** the open
  question above resolves to "yes, we need one" — then it's a named migration, proposed and
  confirmed before writing it, never bundled silently into this task's diff.

## Definition of done

Same as every task here (`docs/RULES.md` §2): typecheck clean, unit + integration tests pass
against real Postgres, smoketested on 9008, `npm run build` green with the dev server stopped,
self-reviewed, committed with a message explaining why, bible amended only if a real decision
got made (a schema addition for thresholds would qualify).
