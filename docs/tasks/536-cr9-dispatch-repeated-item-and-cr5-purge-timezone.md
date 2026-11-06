# T-536 - CR-9 commissary dispatch repeated item, CR-5 cutover purge time zone

Owner: AUDIT. Number given by BOSS 6 Nov 2026 (Ian: "fix CR-9 and CR-5"). No migration. Source findings:
`shareat-audits/OPEN/claude-current-revision-2026-11-03-findings.md` (CR-5, CR-9). Base: origin/main 71993ad.

## CR-9 - a line repeated on one record fails with a raw database error

Re-located on main 71993ad.

- **Stock transfers (`transferNow`, `saveDraft`)**: ALREADY REFUSED in words. `validateTransferRequest`
  (packages/domain/src/stock/transfer-rules.ts:48-58) refuses an item on two lines before any write, and both entry points
  call it (transfers.ts:92, :164). The audit's CR-9 guess for this half is not a defect. Only the wording names the item by id,
  not by name; the test below pins the refusal so it cannot regress.
- **Commissary dispatch (`dispatchOrder`, packages/domain/src/commissary/transfer.ts:197)**: CONFIRMED reachable.
  `consume()` is called once per line with ONE `sourceId` (the order id, line ~248). Two lines with the same item and the
  same source room write two movements with the same (source_type, source_id, item_id, location_id), which the unique index
  `stock_movements_source_pair_key` rejects (raw 23505, whole dispatch rolled back, no corruption).
  The branch's own lines cannot repeat an item (`trade_order_lines_internal_item_key`, migration 0072, partial on
  `requested_quantity IS NOT NULL`). A line the commissary proposes (`proposeLine`,
  packages/domain/src/commissary/fulfilment.ts:224-241) has `requestedQuantity: null`, so the index does not cover it, and
  nothing refuses proposing an item already on the order without `replacesLineId`. That order then cannot be dispatched and
  the user sees a developer message.

Fix: `dispatchOrder` refuses, before the first write and in words, when two lines share (item, source room), using the
T-512 helper `repeatedItemSentence` (packages/domain/src/stock/usage.ts:76). It returns the same `{ ok: false, reason }`
shape the other refusals use, so `dispatchTradeOrder` still throws it as `dispatchTradeOrder: <sentence>`.
Out of scope: refusing the proposal itself at `proposeLine` (a UI/process choice for the planner).

Files: packages/domain/src/commissary/transfer.ts, packages/domain/tests/integration/commissary-transfer.test.ts (new describe), packages/domain/tests/integration/stock-transfers.test.ts (new guard describe).

## CR-5 - the purge cutoff uses the server's time zone

`purgeProduction` (packages/db/src/cutover/purge.ts:593-597) runs
`delete from <t> where <dateColumn> < $1` with `keepFrom = '2027-01-01'`. On a `timestamptz` column (the lobby tables'
`created_at`) the text is read in the SESSION time zone, so on a UTC session the cutoff is 08:00 Manila and rows created
00:00-08:00 Manila on 1 Jan 2027 are deleted. `date` columns are unaffected.

Real mechanism (found while writing the red test): the session zone is NOT the cause here. For a timestamptz column the
postgres driver serialises a bare `$1` text value as `new Date(x).toISOString()`, which reads a date-only string as UTC
midnight, so the cutoff is always 08:00 Manila whatever the session zone is. The red test fails in UTC, America/Los_Angeles
and Asia/Manila sessions alike.

Fix: new exported `deleteBeforeCutoff(tx, table, column, keepFrom)` (the loop in `applyPurge` calls it). It reads the
column's type from `pg_attribute`; for `timestamp with time zone` the cutoff is
`($1::text)::timestamp at time zone '<BUSINESS_TIMEZONE>'` (text cast, so the driver does not touch it); for `date`,
`($1::text)::date`; any other type is refused before the delete. The zone is `BUSINESS_TIMEZONE` from
`@shareat/core/datetime` (one definition, no copied literal).

Files: packages/db/src/cutover/purge.ts, packages/db/tests/integration/t536-cr5-purge-time-zone.test.ts.

## Tests (red before the fix)

- CR-9 dispatch: two lines, same item, same room -> `dispatchOrder` returns `ok: false` naming the item, with no stock
  movement written. Red on old code (throws a unique violation).
- CR-9 transfers: two lines same item -> `transferNow` and `saveDraft` refuse in words (green from the start; a guard).
- CR-5 (`t536-cr5-purge-time-zone.test.ts`): a timestamptz column in UTC, Los Angeles and Manila sessions: rows at 2027-01-01
  00:00, 02:00 and 12:00 Manila survive, 2026-12-31 23:00 Manila is deleted. Red on old code in all three zones (02:00 row
  deleted). A `date` column behaves as before.
