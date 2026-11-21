# T-602 — Performance first pass: receipt indexes, findings once, session memo, sub-ledger filters

Status: SPEC (Opus), 2026-11-18. Source: `docs/reviews/2026-11-18-performance-review.md` (every finding below re-checked in
code on main bc30e0b; corrections are marked **Corrected**). Risk: **high** (one migration; S3 touches the request's auth path;
S5 touches AP/AR money queries). Builder: Sonnet. One builder, slices in order, one commit each.
Numbers: migration **0263** (BOSS: T-600 holds 0262; **whichever of T-600 / T-602 reaches main second renumbers** its file,
journal idx and `when`). DEF-919 (fixed in S5). No capability, no new table, no bible row.

**What must never change, in every slice:** every figure on every screen identical to the centavo; the same rows in the same
order; the same refusals; every `authorize()` / `can()` inside domain services and actions still runs on every call.

## S1 — Migration 0263: indexes for POS receipts and on-hand (size S)

How migrations run here: `packages/db/migrate.ts:44` calls drizzle's postgres-js `migrate()`, which applies **all pending
migrations in ONE transaction** (0218 header, "LOCK BUDGET"; 0045:21-25). `CREATE INDEX CONCURRENTLY` cannot run inside a
transaction, so it is **not used** (same choice as 0045, 0218, 0261). A plain `CREATE INDEX` takes a SHARE lock: reads go on,
**inserts wait** until the migration commits. Lock impact: `pos_sales_receipts` is near-empty before go-live (milliseconds);
`stock_movements` holds the ETL history, so BOSS reads `select count(*) from stock_movements` (read-only) before deploy and
the build is seconds at most. File opens with `SET LOCAL lock_timeout = '5s';` (0261's pattern) so a busy table fails the
deploy instead of queueing every POS insert behind it; a failed deploy is re-run, never edited. Not 05:30-07:00 Manila. R3: 0263
deploys in its own PR, after 0262 is live, so its locks are timed on their own. **Ship before go-live**, while small.

File `packages/db/migrations/0263_t602_performance_indexes.sql`, header per ADR-012 §5 step 2 (task, why, lock budget, "NO new
table, so no classification or RLS registry entry" — confirmed: the build guard keys on tables, 0261:20 is the precedent).
Journal: idx 263, `when` = 0261's 1808623907084 + 2 x 86,400,000 = **1808796707084** (above 0262's 1808710307084).
Each statement its own `--> statement-breakpoint`:

| # | DDL | Query that needs it | Why this column order |
|---|---|---|---|
| X1 | `CREATE INDEX "pos_sales_receipts_store_issued_idx" ON "pos_sales_receipts" ("store_id", "issued_at_device" DESC, "id" DESC);` | `listReceiptsSince`, `repo/pos-v2.ts:599-605` (from `domain/pos/sale.ts:437`, the till's open-window list) | equality column first, then the range/sort column; `id DESC` matches the `ORDER BY` tiebreak so there is no sort step |
| X2 | `CREATE INDEX "pos_sales_receipts_day_close_idx" ON "pos_sales_receipts" ("day_close_id", "issued_at_device", "id") WHERE "day_close_id" IS NOT NULL;` | `listReceiptsOfClose`, `pos-v2.ts:962-967` (Z reading `day-close.ts:234`, v1 bridge loop `day-close.ts:572`) | one close is one store (FK `pos_sales_receipts_day_close_same_store_fk`), so `store_id` adds nothing; trailing columns = the `ORDER BY` |
| X3 | `CREATE INDEX "pos_sales_receipts_open_idx" ON "pos_sales_receipts" ("terminal_id", "issued_at_device", "id") WHERE "day_close_id" IS NULL;` | `listOpenReceipts`, `pos-v2.ts:953-958` (Z preview/close, `day-close.ts:128`) | partial on the unclosed day only, so it stays tiny forever; order = `ORDER BY` |
| X4 | `CREATE INDEX "stock_movements_store_item_qty_idx" ON "stock_movements" ("org_id", "store_id", "item_id") INCLUDE ("quantity");` | `lowStock`, `repo/low-stock.ts:39-46` (dashboard `page.tsx:89`, once per store); findings on-hand CTEs | matches `where org_id, store_id` + `group by item_id`; `INCLUDE` makes it index-only (no heap visit) |

Current code that X1 serves (`pos-v2.ts:600-605`):
```ts
const where = and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId),
  since ? sql`${posSalesReceipts.issuedAtDevice} >= ${since}` : undefined);
return tx.select().from(posSalesReceipts).where(where).orderBy(desc(posSalesReceipts.issuedAtDevice), desc(posSalesReceipts.id));
```
**`maxTerminalSeq` rewrite (no index needed).** `pos-v2.ts:735-741` joins `pos_terminals` and filters `terminal_no`, so the
planner reads every receipt of the terminal to take a max. `(store_id, terminal_no)` is UNIQUE (0238 `pos_terminals_store_terminal_no_unique`),
so the terminal row is already in hand (`snapshot.ts:21` `terminal`). Change the signature to
`maxTerminalSeq(tx, orgId, terminalId: string)` with `where org_id = $1 and terminal_id = $2`, no join; the existing UNIQUE
`(terminal_id, receipt_seq)` then answers with one backward index step. Caller `snapshot.ts:80` passes `terminal.id`.
**Corrected:** the review cites `snapshot.ts:99`; it is `:80`, and it runs per snapshot build, not per 3 s poll.

Schema (ADR-012 §5 step 3): in `packages/db/schema/pos-v2.ts` receipts block (after line 497) add `index('pos_sales_receipts_store_issued_idx').on(t.storeId, t.issuedAtDevice.desc(), t.id.desc())`
and the two partial indexes with `.where(sql\`${t.dayCloseId} is not null\`)` / `is null`, each with a `// NOTE: hand-added in migration 0263`
line (style: `table_sessions_store_open_idx`, line 216-219). `schema/stock-ledger.ts:156`: drizzle cannot say `INCLUDE`, so
only a `// NOTE: stock_movements_store_item_qty_idx (org_id, store_id, item_id) INCLUDE (quantity) - hand-added in migration 0263.`

**Dropped from the review's list, with reasons.** I3 `pos_events (store_id, received_at)` and I8 `table_sessions` — the export
filters on expressions (`manilaDate(received_at)`, `pos-v2.ts:1274`; `businessDateOfInstant(...)`, `:1214-1216`), so a plain
column index is never used (**Corrected**); the export is out of scope. I4 `audit_log` — replaced by a code skip (S6-1).
I6 `journal_lines (account_id, store_id) INCLUDE ...` — a write cost on the hottest table with no measured gain; follow-up
after a seeded EXPLAIN. I7 `expense_payments` partial — after S5 the existing `expense_payments_expense_id_idx` serves the
filtered CTE. `deliveries (store_id, created_at)` — minor, `deliveries_store_status_idx` exists; not now.

Proof without production data, new `packages/db/tests/integration/t602-indexes.test.ts` (pattern `t592-migration.test.ts`:
`_test` DB guard, every probe in a transaction that is always rolled back):
- M1 file `0263_*.sql` names t602; journal idx 263, `when` = previous entry's `when` + 86,400,000 x idx gap, breakpoints true.
- M2 each X1-X4 exists in `pg_indexes` with the exact `indexdef` (predicate and `INCLUDE` included).
- M3 inside the tx: `SET LOCAL enable_seqscan = off`, `EXPLAIN` the SQL of `listReceiptsSince`, `listReceiptsOfClose`,
  `listOpenReceipts`, `lowStock` (hand-written copies, each commented with its `file:line`); assert the plan names X1/X2/X3/X4.
  `EXPLAIN` of the new `maxTerminalSeq` names `pos_sales_receipts_terminal_seq_unique` and contains no `Join`.
  **Mutant:** `DROP INDEX` X1 inside the tx, re-EXPLAIN → plan no longer names it (assert red, then roll back).
- Existing `packages/domain/tests/integration` POS snapshot test(s) that read `lastTerminalSeq` stay green unchanged
  (`git grep -n lastTerminalSeq packages/*/tests`). Add one: two terminals in one store, sales on both → each snapshot's
  `lastTerminalSeq` is its own terminal's max. **Mutant:** drop the `terminal_id` filter → red.
Guards: `packages/db/tests/migration-journal.test.ts` (grid), the tag-file test, `db-generate-retired.test.ts`. No census moves.

## S2 — Findings feed computed once per load (size XS)

Verified: `apps/erp/src/app/findings/lib.ts:66-71` calls `listFindings` then `closeReadiness`, and `closeReadiness`
(`packages/domain/src/findings/index.ts:383-393`) calls `listFindings` again: ~45 detectors (`index.ts:181-286`) twice, on
both `/` (`page.tsx:118`, which then uses only `feed`) and `/findings` (`findings/page.tsx:53`).
```ts
const feed = await listFindings(tx, orgId, { period });
const readiness = await closeReadiness(tx, orgId, period);
return { feed, readiness };
```
Change, keeping ONE rule (the file's own warning, `lib.ts:63`): in `findings/index.ts` add
`export function readinessOf(feed: FindingsFeed): { ready: boolean; blocking: Finding[] }` holding the two lines now at 391-392;
`closeReadiness` becomes `return readinessOf(await listFindings(tx, orgId, { period }));` (unchanged for `fiscal-periods/index.ts:64`
and every test). Export `readinessOf` from `@shareat/domain` beside `closeReadiness`. `findingsFor` returns
`{ feed, readiness: readinessOf(feed) }` and drops the `closeReadiness` import. Fix the comment at `lib.ts:60-65` to say "filtered from the same feed".
Tests: unit `packages/domain/tests/unit/t602-readiness-of.test.ts` — an acknowledged hard finding still blocks; soft never blocks.
Integration `apps/erp/tests/integration/t602-findings-once.test.ts`: `vi.mock('@shareat/domain', ...)` with pass-through
`vi.fn` wrappers on `listFindings` and `closeReadiness`; on a fixture with one hard finding, `findingsFor` → `listFindings`
called **once**, `closeReadiness` **zero** times, and `readiness` deep-equals a separate `closeReadiness(tx, ...)` on the same
fixture. **Mutant:** restore the `closeReadiness` call → red. Existing `findings.test.ts:908-917,1167`, `fiscal-period-close.test.ts` stay green unchanged.

## S3 — Per-request memo of the session and the capability set (size S)

Verified: `lib/session.ts:106-118` `currentSession()` opens an auth transaction on every call; `AppShell.tsx:34` and
`requireSession` each call it; `page-access.tsx:51` (`requirePageAccess`) and `:57` (`holdsAny`) and `AppShell.tsx:57-60` each
read `heldCapabilities` in their own transaction. The dashboard therefore resolves the session about 4 times and the
capability set 3 times before its own queries. No `cache(` exists in `apps/erp/src`.

Pattern: React `cache`, which Next documents for exactly this (main checkout `node_modules/next/dist/docs/01-app/02-guides/authentication.md:1135-1161`).
Runtime: the server build `next/dist/compiled/react/cjs/react.react-server.production.js` exports `cache`. Two traps, both checked:
`apps/erp` types are `@types/react` 18.3.31, where `cache` is only in `canary.d.ts:65`; and vitest resolves plain `react`
18.3.1, which has no `cache`, so a bare `cache(...)` at module load would crash every test importing `session.ts` (e.g. `apps/erp/tests/flash.test.ts`).
So: new `apps/erp/src/lib/request-memo.ts`, about 6 lines:
```ts
/// <reference types="react/canary" />
import * as React from 'react';
// shortcut: outside a React server render (vitest, scripts) this calls straight through with no memo; correct, only slower.
export const requestMemo: typeof React.cache = typeof React.cache === 'function' ? React.cache : ((fn) => fn);
```
- `session.ts`: `export const currentSession = requestMemo(async (): Promise<ResolvedSession | null> => { ...body unchanged... });`
- `page-access.tsx`: `export const heldFor = requestMemo((orgId: string, personId: string) => withOrgPrincipal(orgId, (tx) => heldCapabilities(tx, { orgId, personId })));`
  keyed on the two **primitive** ids, so the key is the person, never an object identity. `requirePageAccess` and `holdsAny`
  call `heldFor(actor.orgId, actor.personId)`. `AppShell.tsx:57-60` takes `held` from `heldFor(...)` and keeps
  `commissaryUsage` in its own `withOrgPrincipal` call.

**Memoised:** the token-to-session lookup and the page-level READ capability set (nav filter, route gate, `holdsAny`), for one
render of one request. React scopes `cache` per server request; it is never module state. **Not memoised:** `authorize()` and
`can()` in every domain service and action; `reportScope`'s `scopedStores` and `authorizeForScope` (`reports/lib.ts:90-111`);
`resolveActor` calls from server actions and route handlers (actions use `requireSession` too, but nothing may rely on the memo
there: a sign-out or role change in the same action must not read a stale set, and the action's own `authorize()` is the gate).
No `let`/`Map` cache at module scope anywhere.

Tests:
- unit `apps/erp/tests/t602-request-memo.test.ts`: (1) outside a render `requestMemo(fn)` calls `fn` on every call (two calls,
  two invocations) — so no cross-request sharing exists in that path; (2) with React's real `cache` substituted by a single-request
  Map-backed stand-in (inject via the module's export), `heldFor('org','A')` then `heldFor('org','B')` runs the loader twice and
  returns each person's own set; same id twice runs it once. **Mutant:** key `heldFor` on `orgId` only → (2) red.
  (3) source scan (`codeOnly` from `tests/unit/lib/document-facts`) of `session.ts` and `page-access.tsx`: no module-level `new Map(`,
  `let ` caches or `WeakMap`. **Mutant:** add `const memo = new Map()` → red.
- Existing guards stay green: `tests/unit/no-direct-transaction-in-erp.test.ts` (still `withOrgPrincipal`),
  `tests/unit/no-client-supplied-actor.test.ts`, `tests/unit/route-capability-coverage.test.ts`, `apps/erp/tests/integration/sign-out-action.test.ts`,
  and every integration test that `vi.mock`s `src/lib/session` (they replace the module wholesale; unaffected).
- Smoketest (the only proof of the real per-request scope): dev server on 9008, two browsers, an owner and a cashier signed in,
  load `/` and `/findings` at the same time ten times → each sidebar shows only its own links; the cashier gets the welcome
  fallback, never the dashboard. Write what was seen in the commit.

## S4 — The dashboard's query load: what changes now and what does not (size XS, mostly decisions)

Verified shape (`apps/erp/src/app/page.tsx:72-121`): three transactions run in parallel on three connections — `runReport`
(14 reads, serial on one connection although written as `Promise.all`), `findingsFor`, `statutoryTileFor`. Wall time is the
slower of the first two.
- **Findings** (the largest share): S2 halves it. Nothing more in this task.
- **Balance sheet from inception** (`domain/reports/balance-sheet.ts:109-128`): two full aggregates over all posted lines
  (`v_balance_sheet` and `v_income_statement`, 0128 / 0010) for two numbers on the page (`assets`, `ties`, `page.tsx:283-284`).
  No bounded rewrite exists without stored balances. **Follow-up (named, not this task):** `period_balances(org, store,
  account, party, period)` written at post time, balance = closed months + the open month. Needs its own spec, migration and
  a reconcile test against the views.
- **AR/AP control totals** (`ap.ts:588-599`, `ar.ts:152-165`): **Corrected** — not "whole ledger": they read control-account
  lines only (`a.code = 2100/1210`, `journal_lines_account_id_idx`). Grows with AP/AR activity only. Leave.
- **AR/AP aging** for the tiles: fixed by S5.
- **Low stock**: X4 (S1) plus one query for all stores (S6-7).
- **Rejected:** splitting the 14 reads into more transactions. The pool is 10 (`packages/core/src/env.ts:53`) and is shared
  with every POS poll; more parallel connections per dashboard view trades page speed for till latency. Revisit with stored balances.
- **Proof:** no code here beyond S2/S5/S6-7; record before/after `EXPLAIN (ANALYZE, BUFFERS)` of `getBalanceSheetLines` on the
  seeded `_test` DB in the commit as the baseline for the follow-up.

## S5 — AR/AP sub-ledger CTEs filtered to the org and the rows asked for (size S, money)

Verified: the `credit`, `allocated`, `written` CTEs aggregate whole tables, no org filter. PostgreSQL inlines a single-use CTE
but cannot push the `c.expense_id = e.id` join into a `GROUP BY`, so every call groups every row. Sites:
`ap.ts:704-716` (`openItemsQuery`, used by `openItems` :682 and `openItemsForStores` :776), `ap.ts:862-874` (`aging`),
`ar.ts:257-266` (`openItems`), `ar.ts:385-394` (`aging`). Multiplied by per-store loops `apps/erp/src/app/ap/lib.ts:203-204`
and `customers/lib.ts:182-183`. Current (`ap.ts:705-708`):
```sql
with credit as (
  select ep.expense_id, sum(ep.amount) as credit_amount
  from expense_payments ep
  where ep.method = 'credit'
  group by ep.expense_id
```
Change — add a semi-join to the same rows the outer query reads, inside each grouping CTE, nothing else:
- AP `openItemsQuery`: in `credit` and `allocated`, `and <x>.expense_id in (select e.id from expenses e where e.org_id = ${orgId} ${filterTail})`
  (`filterTail` references only `e.` columns — its two callers checked — so reusing it under the same alias is exact).
- AP `aging`: same, with `${storeId ? sql\`and e.store_id = ${storeId}\` : sql\`\`}`.
- AR `openItems`: in `allocated` and `written`, `and <x>.ar_charge_id in (select ch.id from ar_charges ch where ch.org_id = ${orgId} and ch.customer_id = ${customerId} and ch.store_id = ${storeId})`.
- AR `aging`: same with the optional store tail. `creditedCtes` already takes a filter (`ar.ts:267`, `:395`); leave it.
The outer `WHERE` is unchanged, so the rows and figures cannot change: the CTEs now hold only rows the outer join could match.
The per-store loops stay (each call is now an indexed lookup via `expense_payments_expense_id_idx`, `ap_payment_allocations_expense_idx`, `ar_collection_allocations_charge_idx`).
Tests: `packages/db/tests/integration/t602-subledger-filter.test.ts` — two orgs, each with suppliers/customers, partial
payments, allocations, write-offs and a voided invoice: `openItems`, `openItemsForStores`, `aging` (AP and AR, store and
org-wide) return exactly the same rows and strings as a copy of the pre-change SQL kept in the test file (snapshot by value).
Plan proof: `EXPLAIN` of AP `aging` for one store shows `expense_payments` reached by `Index Scan using expense_payments_expense_id_idx`
under `enable_seqscan = off`, and `Seq Scan on expense_payments` is absent. **Mutant:** delete the `credit` semi-join → plan
assertion red. Existing `packages/domain/tests/integration` AP/AR aging and the T-209b reconciliation tests (control total = aging total) stay green unchanged.
**DEF-919, fixed inside S5 (R4).** AP `aging` (`ap.ts:904-908`) and AR `aging` (`ar.ts:420-424`) map each bucket as
`current: Number(r.current).toFixed(2)` (and `d1to30` .. `d90plus`), although the SQL already returns exact `numeric::text`.
Change all 10 fields to `money(r.current)` etc. from `@shareat/core/money` (already imported, `ap.ts:15`; widen `ar.ts:13`'s
`import type { Money }` to also import `money`). Callers `domain/reports/ap-aging.ts:62` and `ar-aging.ts:72` already sum with
core money; no change there. `ar.ts:504-508` (`platformAging`) has the same pattern and is not in the ruling: leave it, and
name it in the register row as the same defect, still open.
Drift test (same file): one numeric(14,2) value survives a float round trip, but a bucket SUM can pass 2^47, where floats are
1/32 apart. AP fixture: one supplier, one store, 150 open credit invoices of ₱999,999,999,999.99 plus one of ₱0.51, all in one
bucket → SQL sum `149999999999999.01`; `Number(...).toFixed(2)` gives `...999.00`. Assert the bucket === `'149999999999999.01'`.
Same for AR (151 charges). **Mutant:** put `Number(...).toFixed(2)` back on `current` → red. If a CHECK or domain rule refuses
an amount that size, stop and report it (do not weaken the fixture). Ordinary fixtures still equal the pre-change SQL copy
to the centavo. The builder adds the DEF-919 row to `docs/DEFECTS-REGISTER.md` section E, in the DEF-866 format (line 1064),
marked `fixed - T-602`.

## S6 — Quick wins checklist (size S total; one commit, each item its own test or noted)

| # | File:line (bc30e0b) | One-line change | Proof |
|---|---|---|---|
| 1 | `packages/domain/src/pos/day-close.ts:677` | `const marks = link && rows.some((r) => v1BridgeDateAllowed(r.close.businessDate)) ? await auditLogRepo.listForStoreActions(...) : [];` (statuses already ignore marks then, `:683`) | existing `t531-v1-bridge.test.ts` green; new case: no link → `listForStoreActions` not called (spy) |
| 2 | `apps/erp/src/app/ap/lib.ts:164-165` | one `apRepo.capacityOfMany(tx, orgId, invoices.map((i) => i.id))` before the loop, `.get(inv.id)` inside (same `{remaining}` strings, `ap.ts:443-447`) | picker options identical on an AP fixture |
| 3 | `apps/erp/src/app/inventory/returns/page.tsx:84-87` | one grouped `2140`-style balance query per org (copy `positionsBySupplier`, `ap.ts:604`) instead of `supplierCreditBalance` per supplier | same map as the loop on a fixture |
| 4 | `apps/erp/src/app/trade/returns/page.tsx:87-90` | same for `customerCreditBalance` per customer | same |
| 5 | `packages/db/src/repo/reports.ts:276-294` (drill-down) | `.limit(501)`; page shows 500 and "Narrow the dates to see the rest" when 501 came back | test: 501 lines → notice; totals on the report page unchanged (drill-down never sums) |
| 6 | `packages/domain/src/sync/publisher.ts:72` | `options.limit ?? 100` | existing publisher test green |
| 7 | `packages/db/src/repo/low-stock.ts:39` + `page.tsx:89` | `lowStock(tx, orgId, storeIds: string[])` with `store_id = any(...)`, returning rows with `storeId`; dashboard calls it once. Other callers `inventory/low-stock/page.tsx:44` and `domain/src/commissary/auto-order.ts:92` pass `[storeId]` | same count on a two-store fixture |

## Out of scope, with reasons
- POS data export memory (`pos-v2.ts:1205-1291`, finding 6): needs streaming and a sargable date bound; not a one-liner. Follow-up.
- Items similarity join (`repo/items.ts:842-879`): `%` uses `pg_trgm.similarity_threshold`, not the page's floor, so it changes
  results; a "Check duplicates" button is a UI change. Follow-up.
- Network calls in transactions (13), settlement re-parse (14), POS state poll (7), `pos_events` retention (17), payroll rate
  lookups (18), stored balances (S4). Each needs its own spec.

## Build order and commands
S1 (migration first; its own PR per RULES "a slice carrying a migration", prechecks with BOSS before deploy) → S2 → S3 → S5 → S6.
S4 is analysis recorded in the S2 commit message. Line endings LF; check `git diff --stat` size before each commit.
Machine limit: stay under 90% memory — no whole-repo `tsc`, no full suite locally; typecheck and the full suite run in CI on the PR.
```
npx vitest run --project integration packages/db/tests/integration/t602-indexes.test.ts --maxWorkers=2
npx vitest run --project unit packages/db/tests/migration-journal.test.ts packages/db/tests/db-generate-retired.test.ts --maxWorkers=2
npx vitest run --project unit packages/domain/tests/unit/t602-readiness-of.test.ts apps/erp/tests/t602-request-memo.test.ts apps/erp/tests/flash.test.ts --maxWorkers=2
npx vitest run --project integration apps/erp/tests/integration/t602-findings-once.test.ts packages/domain/tests/integration/findings.test.ts packages/domain/tests/integration/fiscal-period-close.test.ts --maxWorkers=2
npx vitest run --project integration packages/db/tests/integration/t602-subledger-filter.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t531-v1-bridge.test.ts apps/erp/tests/integration/sign-out-action.test.ts --maxWorkers=2
npx vitest run --project unit tests/unit/no-direct-transaction-in-erp.test.ts tests/unit/no-client-supplied-actor.test.ts tests/unit/route-capability-coverage.test.ts --maxWorkers=2
```
Plus the AP/AR aging and POS snapshot integration files found by `git grep -l "aging(\|lastTerminalSeq" packages/*/tests apps/erp/tests`.
Smoketest on 9008 (S3 two-browser check; `/`, `/findings`, `/ap`, a customer page, the till Z history).

## Rulings (BOSS, 18 Nov)
R1. The "Books: Ties" tile stays as it is (from-inception income statement). Getting it from the findings feed's
`trialBalanceDoesNotTie` instead is a **follow-up**, done together with stored balances (S4).
R2. X4 (`stock_movements_store_item_qty_idx`) ships in 0263.
R3. 0262 (T-600) and 0263 (T-602) deploy **apart, each in its own PR, 0262 first** (S1 lock budget updated).
R4. DEF-919: the AP/AR aging float conversion is fixed inside S5 (see S5), with the drift test and its mutant. The builder adds the register row.

No open questions remain.
