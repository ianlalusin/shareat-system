# T-551 — The v1 day import stops for v1 stores from 1 Jan 2027

> **Status:** spec written 11 Nov 2026 by the POS design lane (Opus planner). Not built. **It must ship before
> 31 Dec 2026.**
> **Migration:** none. **Risk:** medium. It stops a feed into the books, but writes nothing new. The builder is
> Sonnet, with a Sonnet auditor (money source).
> **Authority:** bible row 452 (b), Ian, 8 Nov: *T-396, the 06:00 v1 day import, keeps importing v1 stores until
> 2026-12-31, then stops for v1 stores from 2027-01-01. The 2026 rows stay.* Row 452 (c): only sales and stock stay
> in v1 for a v1 store.
> **Code:** `packages/domain/src/pos/day-import-job.ts` (`posDayImportSweep`, the 06:00 job) and
> `packages/domain/src/sales-days/import.ts` (`importSalesDay` and `reimportSalesDay`, the manual import from the
> sales-day page).

## Goal

From business date **2027-01-01**, the v2 ERP never creates or rewrites a sales day from the v1 day feed, for any store.
- Stores still on POS v1 keep their 2027 sales in the v1 ERP (row 452).
- Stores on POS v2 already get their days from POS receipts (T-531). The 0247 guard already refuses a v1-feed day on
  or after a live store's `live_from`.
- Every sales day dated 2026 or earlier is left exactly as it is.

## R1 — The cut-off date

- Add a named constant beside the import: `V1_DAY_FEED_LAST_DATE = '2026-12-31'`, with a one-line comment that cites
  row 452 (b).
- This is a date fixed by Ian's ruling, not an adjustable business setting. It is the same kind of value as T-531's
  `V1_BRIDGE_LAST_DATE`. Reuse one shared constant if T-531's has already merged and fits. Otherwise define it once in
  the sales-days area and import it in both places.

## R2 — The 06:00 sweep (`posDayImportSweep`)

- For every store, the latest date the sweep imports is `min(yesterday, V1_DAY_FEED_LAST_DATE)`. From the morning of
  1 Jan 2027, the sweep still catches up the last days of December within its 7-day window. Once the window passes
  31 Dec, it imports nothing.
- The **gap notice** ("older than the 7-day window and has no sales day") must not count dates after the cut-off. No
  2027 date is ever reported as missing.
- A run with nothing left to import reports that cleanly. It is not a failure.
- The links (`pos_v1_store_links`) stay as they are. This task does not remove them, because they are still needed
  for December and for the T-531 bridge.

## R3 — The manual import and reimport

- `importSalesDay` and `reimportSalesDay` refuse any `businessDate > V1_DAY_FEED_LAST_DATE`, with the sentence
  "From 2027 the v1 day feed is not imported into this ERP. Stores on POS v1 keep their sales in the v1 ERP." This check
  runs first, before any fetch.
- The sales-day page hides the "Import from POS" action for a date after the cut-off, and shows the same sentence. Use
  the existing page pattern; this adds no new screen.

## R4 — Tests (each ✅ with its ✗)

- Sweep with an injected `now`:
  - on 2026-12-31 it imports up to 30 Dec;
  - on 2027-01-03 it imports only the missing December dates (29–31 Dec), never 1–2 Jan;
  - on 2027-01-15 it imports nothing and no failure is written;
  - the gap notice never lists a 2027 date.
- Manual import:
  - 2026-12-31 works;
  - 2027-01-01 is refused with the exact sentence, and nothing is fetched (check that the fetcher is not called);
  - reimport of a 2027 date is refused the same way.
- Page: no import action for a 2027 date, and the sentence is shown.
- Every existing T-396 and import test still passes for 2026 dates.

## R5 — Gates

Typecheck, unit, and the T-396 / day-import and sales-days integration suites, on the lane's own `_test` DB with its
**own `npm ci`**. **Never print any `.env.local` value.** Do not touch the systemd timer. The 06:00 job keeps running
and simply finds nothing to import after the window passes.
