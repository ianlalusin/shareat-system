# Performance review, 2026-11-18

Read-only pass over `main` (`wt-plans`). No Node, no DB, no EXPLAIN: every claim is from reading code and migrations.
Volumes are the brief's: 5 stores, hundreds of receipts a day each, ledger in the millions, 126 staff.
Ops notes mention running prechecks "as `doadmin`", which suggests a managed DB. If so every query is a network
round trip, and the N+1 and query-count findings cost more than they look. Not confirmed.
A schema file does not list every index (some are hand-added in migrations), so each "missing" below was checked in `packages/db/migrations/`.

Impact tags: PAGE = page slow, MEM = server memory, LOCK = lock or connection held, MINOR.

## Ranked findings

1. **PAGE. The findings feed runs twice on the dashboard and on /findings.**
   `apps/erp/src/app/page.tsx:118` calls `findingsFor`; `findings/lib.ts:66-71` calls `listFindings` then `closeReadiness`,
   and `closeReadiness` (`packages/domain/src/findings/index.ts:383-392`) calls `listFindings` again.
   About 45 detectors, run one after another (`index.ts:176-290`). Around 16 scan every journal line
   (`repo/findings.ts:84,109,143,221,283,358,383,406,857,964,1249,1286,1331,1458,1733,2210`).
   Others sum all of `stock_movements` (`:1127-1160`, `:1204`). `receiptPriceSpike` (`:2102-2150`) runs a median subquery for
   every received delivery line ever, with no date window.
   At volume: each dashboard load is two full-ledger passes plus two scans of all delivery lines, growing every month.
   Fix: reuse `feed` for `readiness` (blocking = hard findings), then read open rows from the daily observation job (T-214) instead of re-deriving.
2. **PAGE. The dashboard aggregates the whole ledger from inception, about 140 queries per render, in one transaction.**
   `getBalanceSheet` reads `fromDate: INCEPTION` and also runs an income statement from inception (`domain/reports/balance-sheet.ts:113,124`).
   `orgAgingTotal` and `arRepo.orgAgingTotal` sum every control-account line (`ap.ts:588`, `ar.ts`).
   The `Promise.all` at `page.tsx:61-118` runs inside one `runReport` transaction, so postgres.js sends the queries down one connection, one at a time.
   Rough count: ~90 findings queries (finding 1), ~40 report queries, ~10-15 auth and scope queries.
   No journal-line summary exists, and `journal_lines` has no `org_id`, so every report joins `journal_entries`.
   Fix: a `period_balances(org, store, account, party, period)` table written at post time or at period close; a balance sheet is then
   opening balance plus the open months. Short term: run heavy tiles in their own `Suspense` boundaries with their own transactions.
3. **PAGE. AR and AP aging and open-item queries aggregate the whole sub-ledger every call.**
   `ap.ts:702-730` (`openItemsQuery`), `ap.ts:861-900` (`aging`), `ar.ts:250-262`, `ar.ts:379-412`.
   The `credit` and `allocated` CTEs group all of `expense_payments`, `ap_payment_allocations`, `ar_collection_allocations` with no org or expense filter.
   Loops multiply it: `ap/lib.ts:204` and `customers/lib.ts:183` call it once per store (5 full aggregations per supplier or customer page).
   Fix: filter the CTE inputs by org and by the target expense or charge ids (semi-join to `expenses`/`ar_charges`);
   partial index `expense_payments (expense_id) INCLUDE (amount) WHERE method='credit'`.
4. **PAGE. `pos_sales_receipts` has no index on store, time or day close.** `schema/pos-v2.ts:462-505`; migrations 0238/0240/0248 add none.
   Only `(terminal_id, receipt_seq)`, `table_session_id` and `id` are indexed. Unindexed reads:
   `listReceiptsSince` (`pos-v2.ts:599`, store + `issued_at_device`), `listReceiptsOfClose` (`:962`, `day_close_id`),
   the export (`:1205`), and the Z reading and v1 bridge (`domain/pos/day-close.ts:571`, one `listReceiptsOfClose` per day).
   At ~550k receipts a year each is a sequential scan. Also `maxTerminalSeq` (`pos-v2.ts:735`) joins terminals and aggregates over
   the whole store's receipts; it runs on every tablet snapshot (`snapshot.ts:99`).
   Fix: indexes I1, I2 below; rewrite `maxTerminalSeq` as `where terminal_id = $1` (the terminal id is already in hand).
5. **PAGE (every page). No per-request memo of session and capabilities.**
   `lib/session.ts:106-122` opens a fresh auth transaction on each `currentSession()`. `page-access.tsx:42-60` and `AppShell.tsx` call
   `heldCapabilities` again. No `React.cache` anywhere in `apps/erp/src/lib`.
   The dashboard opens roughly 10 separate transactions before its own queries: AppShell 2, `requireSession`, `holdsAny`,
   `reportScope` (session + capabilities + scope), `runReport`, `findingsFor`, `statutoryTileFor`.
   Pool is 10 (`packages/core/src/env.ts:53`). Fix: wrap `currentSession` and `heldCapabilities` in `React.cache` (per request).
6. **MEM. POS data export loads everything, and scans the two biggest tables.**
   `pos-v2.ts:1205-1290`: up to 62 days (`data-export.ts`, `POS_EXPORT_MAX_DAYS`) into a JS array, then `toCsv` builds one string (`lib/csv.ts:10-25`).
   `device-events` is ~10 jsonb rows per receipt: about 150k-300k rows with payloads, and no index on `(store_id, received_at)`
   so it is a sequential scan. `receiptDate` runs a correlated subquery per receipt.
   The box also hosts POS (768 MB cap) and the lobby (512 MB cap). Fix: index I3; cap `device-events` to 7 days; stream in 5k-row pages.
7. **PAGE/LOAD. POS state poll every 3 s per device.** `use-pos-state.ts:39`, `constants.ts:11`, `api/pos/state/route.ts`.
   Each poll is a session transaction plus a `readPosState` transaction (`snapshot.ts:105`) with a store-scope check, so at least 2 transactions per poll.
   40 devices is about 27 transactions a second all day, before any report. After a version change each device recomputes up to
   5 lists (`snapshot.ts:116-122`). Fix: resolve session, scope and version in one query; cache the session lookup for 10-30 s in the route.
8. **PAGE. Items page does an n-squared similarity join on every view.** `repo/items.ts:842-879`, called from `items/page.tsx:54`.
   `similarity(a, b) >= floor` in the join condition cannot use the trigram GIN index (`items_name_trgm_idx`).
   At ~3,000 items that is ~4.5M `similarity()` calls per page view. Fix: use `a.name % b.name` (index-assisted) or only run it behind a "Check duplicates" click.
9. **PAGE (grows after Dec 2026). Day-close history scans the store's audit log.** `audit-log.ts:431-444` filters by `action IN (...)`.
   Only `(org_id, store_id, occurred_at DESC)` is indexed, so it walks back until it finds 500 matches. Called from
   `day-close.ts:677` on every history load. The v1 bridge marks stop after 2026-12-31, so after that it walks the store's whole audit history every time.
   Fix: skip the lookup when `!link` or the dates are past the bridge; or index I4.
10. **PAGE/MEM. Journal-lines drill-down has no limit.** `reports.ts:256-297` called from `reports/journal-lines/page.tsx:59`.
    The date range is user-set. A cash or COGS account for a year is tens of thousands of rows, all rendered as server HTML.
    Fix: `limit 500` with a "narrow the dates" notice, or keyset pagination on `(entry_date, line_no)`.
11. **PAGE. Low-stock sums all of a store's movement history, per store, on the dashboard.** `low-stock.ts:39-65` via `page.tsx:89`
    (`stock_movements` grouped by item with only `(org_id, store_id, moved_at)` to help). `onHandByStore` (`stock-ledger.ts:143`) does the same.
    Fix: index I5, then a `stock_on_hand(store, item)` table kept by the movement insert; loop the stores into one query.
12. **LOCK. Mirror outbox drain: up to 500 sequential Firestore writes inside one transaction.**
    `domain/sync/publisher.ts:85-105`, run from `scheduler/index.ts:479`. Holds a pool connection and `FOR UPDATE SKIP LOCKED` rows
    (`mirror-outbox.ts:28`) for the whole loop (500 x network round trip). Failed rows keep the lowest ids, so they are retried first every run
    and can crowd a 500-row batch (no back-off). Fix: claim, commit, publish outside the transaction, mark in a second one; cap at 100; skip rows with `attempts > N`.
13. **LOCK. Network calls inside open transactions.** `files/upload/route.ts:121-123` calls `uploadFile`, which does the bucket `put`
    (`domain/files/index.ts:173`) inside `withOrgPrincipal`. `sendV1Bridge` and `resendV1Bridge` write Firestore from inside the caller's
    transaction (`day-close.ts:616,642`). Each holds a pool connection of 10 for the length of the call. Fix: upload first, insert the row in a short transaction after.
14. **LOCK. Settlement ingest re-reads and re-parses every stored counterpart file under the channel advisory lock.**
    `settlement-intake/ingest.ts:104-127` (`counterpartsOf`) after `lockSettlementChannel` at `:217`. Each current Grab file (up to 3 MB)
    is parsed again per upload. Grows with every file until superseded. Fix: store parsed rows (or a digest) at first ingest; parse before taking the lock.
15. **LOCK/MINOR. POS inbox: one transaction per event, and every POS write updates the store's `pos_stores` row.**
    `inbox.ts:444-460` (a 100-event catch-up is 100 sequential transactions); `bumpStateVersion` (`pos-v2.ts:114`). All writes in a store serialise on that row until commit.
    Fine at 5 stores. Watch it if a store bursts after an outage. Fix: batch the version bump to once per batch.
16. **PAGE. N+1 loops over rows (queries per supplier, customer, person, invoice).**
    `inventory/returns/page.tsx:84` (`supplierCreditBalance` per supplier, all suppliers); `trade/returns/page.tsx:87` (per customer);
    `ap/lib.ts:164` (`capacityOf` per open invoice; `capacityOfMany` already exists at `ap.ts:443`);
    `admin/pos-tablets/lib.ts:38` (PIN status per person); `menu/lib.ts:390`; `trade/orders/lib.ts:93,123`;
    `inventory/production/recipes/lib.ts:70`. Fix: one grouped query each (copy `positionsBySupplier`, `ap.ts:604`).
17. **MEM/DISK. `pos_events` grows with no retention and no time index.** About 5M jsonb rows a year (my estimate).
    I found no job that prunes or archives it (`grep` for retention/prune in the pos domain and scheduler). Add retention plus I3.
18. **MINOR. Payroll and leave look up the pay rate once per day per person.** `payroll/index.ts:310`, `leave/payroll.ts:78`: ~400 sequential
    queries for a 25-person store and a 15-day period. Fix: load the rate rows once per employment and resolve in memory.
19. **MINOR. Unbounded per-store lists.** `stock-usage.ts:153` (`listUsageRecords`, all-time, plus an `IN` over every id), `deliveries.ts:324` (`listDeliveries`, all-time, left-join and group).
    About 1k rows per store a year; add `limit` and a `(store_id, created_at DESC)` index.
20. **MINOR. Money-account balances.** `custodianPositions` (`money-accounts.ts:335`) scans org-wide `11xx` lines up to a date; `balancesFor` (`:436`)
    joins `accounts` by code with no org filter. Add the I6 index; fine until the cash accounts reach ~100k lines.
21. **MINOR. POS snapshot builds staff x 5 capability checks (~125 `can()` calls per store) every 5 minutes per tablet.** `snapshot.ts:54-60`. Cache per store for the refresh window.
22. **MINOR. Uploads copy the file 3-4 times in memory.** `next.config.js` `bodySizeLimit: '26mb'`; `arrayBuffer` then `Uint8Array` then `Buffer.from`
    (`channel-settlements/upload/actions.ts:81`, `ingest-many.ts:81`). Settlement files cap at 3 MB and photos at 1 MB, so only an issue with many concurrent uploads.

## Missing indexes (query that needs each)

| # | DDL | Needed by |
|---|---|---|
| I1 | `create index on pos_sales_receipts (store_id, issued_at_device desc)` | `listReceiptsSince` (`pos-v2.ts:599`), Z window |
| I2 | `create index on pos_sales_receipts (day_close_id) where day_close_id is not null` | `listReceiptsOfClose` (`:962`), v1 bridge, readings |
| I3 | `create index on pos_events (store_id, received_at)` | `device-events` export (`:1272`); retention deletes |
| I4 | `create index on audit_log (org_id, store_id, action, occurred_at desc)` | `listForStoreActions` (`audit-log.ts:431`) |
| I5 | `create index on stock_movements (org_id, store_id, item_id) include (quantity)` | `lowStock`, `onHandByStore`, findings on-hand CTEs |
| I6 | `create index on journal_lines (account_id, store_id) include (entry_id, debit, credit)` | per-account and per-store sums (money accounts, drill-down, findings) |
| I7 | `create index on expense_payments (expense_id) include (amount) where method = 'credit'` | `credit` CTE (`ap.ts:703`, `:862`) |
| I8 | `create index on table_sessions (store_id, opened_at)`; `deliveries (store_id, created_at desc)` | export `table-sessions`; `listDeliveries` |

Migrations are hand-authored (ADR-012). Plain `create index` is fine while tables are small; do it before go-live, not after.

## Quick wins (under an hour each)

1. `findingsFor`: build `readiness` from the `feed` already computed. Halves finding 1. Drop in `findings/lib.ts:66-71`.
2. `React.cache` around `currentSession` and `heldCapabilities` (finding 5).
3. One migration for I1-I5 (findings 4, 6, 9, 11, 17).
4. `maxTerminalSeq` by `terminal_id` (finding 4).
5. Day-close history: skip `listForStoreActions` when no v1 link or past the bridge date (finding 9).
6. Journal-lines drill-down: `limit 500` plus a notice (finding 10).
7. Items page: put the duplicate check behind a button or use `%` (finding 8).
8. `inventory/returns` and `trade/returns`: one grouped credit-balance query (finding 16).
9. AP invoice picker: use `capacityOfMany` (finding 16).
10. Dashboard low-stock: one query for all stores instead of one per store (finding 11).
11. Cap `device-events` export at 7 days, or page it (finding 6).
12. Outbox drain: default limit 100, skip rows past N attempts (finding 12).

**Counts.** PAGE 11 (1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 16), MEM 2 (6, 17), LOCK 4 (12, 13, 14, 15), MINOR 5 (18, 19, 20, 21, 22). 22 findings, 8 index groups, 12 quick wins.
**Checked and fine.** `audit_log` has full indexes (0197); attendance queries are store/date bounded with indexes; `listExpenses`, `listSalesDays`, trade `listOrders` are capped;
supplier `positionOf` uses the party index; `mirror_outbox` claim is indexed; settlement files cap at 3 MB and photos at 1 MB; the POS inbox cap is 100 events and 512 KB per batch.

## Not reached

Real query plans and row counts (no DB access; every volume is the brief's or my estimate). `apps/customer` lobby polling and `apps/pos`.
`etl`, `dual-run`, `cutover` and month-end job loops. `loadStoreMenu` cost per snapshot. `authorize()`/`can()` query counts.
Remaining ~25 findings detectors not cited. `platformAging`, fiscal close, statutory reports. Next bundle size and client component hydration cost.
