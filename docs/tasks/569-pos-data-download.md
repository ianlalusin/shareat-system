# T-569 — POS data download (CSV) before the 2027 cutover purge

> Written in plan mode by the POS design lane (Opus planner), 12 Nov 2026. Lands as `docs/tasks/569-pos-data-download.md`.
> **Authority:**
> - BOSS 12 Nov;
> - D-003 ruling (c): the 2027 cutover purge wipes `pos_sales_receipts`, `table_sessions` and `pos_day_closes`;
> - AUDIT's cutover runbook points here.
> **Deadline:** live and tried on production before **20 Dec 2026**.
> **Migration:** none. **New dependency:** none (BOSS: CSV, because main's only xlsx code is the read-only `read-excel-file`, and zip is read-only `yauzl`).
> **Builder:** Sonnet. **Auditor:** Sonnet (money and auth).

## Context

Ian must keep Lipa's December POS v2 data after the purge. No export of POS v2 tables exists. Ian only needs files that open in Excel with **exact pesos and IDs**.

## Design

**One page, several CSV links.** `/reports/pos-data`:
- a store picker, from and to dates, and one download link per table;
- each link hits `/reports/pos-data/export?store=&from=&to=&table=<name>`.

**R1 — What is exported.** Every column of each table, as the database stores it, one file per table. These are all purged or child tables in `packages/db/schema/pos-v2.ts`:

| `table=` | Table | Rows chosen by |
|---|---|---|
| `receipts` | `pos_sales_receipts` (:457) | store + receipt business date in range |
| `receipt-lines` | `pos_sales_receipt_lines` (:508) | receipt in the chosen receipts |
| `receipt-line-discounts` | `pos_sales_receipt_line_discounts` (:647) | same |
| `payments` | `pos_sales_receipt_payments` (:552) | same |
| `day-closes` | `pos_day_closes` (:394) | store + `business_date` in range |
| `day-close-tenders` | `pos_day_close_tenders` (:432) | day close in the chosen closes |
| `table-sessions` | `table_sessions` (:186) | store + EITHER the business date of `opened_at` OR its receipt's business date in range (BOSS 12 Nov, Codex P2: a backup repeats a row in two files rather than lose it). Never the device clock |
| `device-events` | `pos_events` (:594): the raw device log. **Not purged** (BOSS 12 Nov), but exported so the December download is the complete record. `payload` is already scrubbed at insert | store + event time in range (server-side time column if one exists) |

- Header row = database column names.
- Values are the **raw database text**: `numeric` columns come out as Postgres prints them (e.g. `1234.50`), with no `formatMoney`, no `₱` and no thousands comma. A plain decimal string is what `escapeCsvCell` (`packages/core/src/csv.ts`) leaves unprefixed, and Excel reads it as an exact 2-decimal number.
- UUIDs, timestamps (ISO, with offset) and JSON (compact text) are written as strings.
- NULL is an empty cell.
- **No money is recomputed.** It is a copy, not a report.

**R2 — Reads.** One repo function per table in `packages/db/src/repo/pos-v2.ts` (for example `exportRowsForStore(tx, orgId, storeId, from, to, table)`, which returns `Record<string,string|null>[]` plus the column order). Rules:
- it selects with the table's own Drizzle columns;
- it casts to text in SQL so nothing passes through JS numbers;
- it is scoped by org (RLS) and store, and ordered by business date then id.

**R3 — Auth.**
- `reportScope('/reports/pos-data', 'view_financial_reports', store)` (`apps/erp/src/app/reports/lib.ts`).
- **`store` is required.** No org-wide download: if the store is missing or not one of the person's, the answer is 400 or 403 with a sentence. Don't use `reportScope`'s fallback.
- `from <= to`, both valid dates, and the range is at most 62 days. That covers December with margin. It is a technical cap on file size, not a business setting; a comment says so.
- An unknown `table` → 400.

**R4 — Audit every download.** Write the existing catalogued action `data.export_downloaded` (`packages/db/src/audit/catalogue.ts:376`, the first writer of this action) through `auditLog.append`, in the same request, with details {kind:'pos_data', table, storeId, from, to, rowCount}.
- No new catalogue action, so no ceiling change.
- The audit row must be committed even if streaming fails. Write it before building the response.

**R5 — Response.**
- `csvResponse` (`apps/erp/src/lib/csv.ts`), filename `pos-<storecode>-<table>-<from>-to-<to>.csv`.
- Add `Cache-Control: private, no-store`, the same as the leave export (`apps/erp/src/app/attendance/leave/export/route.ts`).
- Add a UTF-8 BOM so Excel opens `ñ` and `₱` in names correctly. Only if `csvResponse` lacks it: add it there behind an option, or prefix it in this route only. Don't change other exports.

**R6 — Page and nav.**
- The page sits under Reports in `nav.tsx`. Use a server component and the existing report page patterns (store select and date inputs like `reports/sales-rollup/page.tsx`).
- One sentence of help: "Download every POS v2 record for one store and date range before the 2027 clean-up. One file per table; open them in Excel."
- Plain words for the link names: Receipts · Receipt lines · Line discounts · Payments · Day closes · Day close tenders · Table sessions · Device log.
- Census updates (only the entries for the new page): nav-route-reachability, route-capability-coverage, t348 page description, action-link-sweep, touch-target baseline.

## Out of scope

| Out | Why |
|---|---|
| xlsx or zip | No writer exists on main. BOSS: no new dependency |
| A totals or summary sheet | It is a copy, not a report. The sales day and the ledger already carry the totals |
| Several stores in one file | One store per file keeps the scope check simple and auditable |

## Tests (first, red, then green)

Integration, on the lane's own `_test` DB, using the existing POS fixtures (`packages/domain/tests/integration/_fixtures/t531-day-close.ts` or `t558-variance.ts`):
1. Every table: header = the column list; a seeded receipt of ₱1,234.50 with 0.01 centavo lines comes out byte-exact as `1234.50`; and NULL is empty.
2. Rows outside the range or from another store are absent.
3. Child tables only contain children of the chosen parents.
4. No store, a store not in scope, a staff user without `view_financial_reports`, more than 62 days, or a bad table → refused, and **no audit row**.
5. A successful download → exactly one `data.export_downloaded` row with the details.
6. A cell starting with `=` (for example a note) is prefixed with `'` (CSV-injection rule kept). Money is never prefixed.
7. Mutant check: format money through `formatMoney` → test 1 goes red.

## Verification

- Typecheck, the census set, the new t569 integration file.
- On production (BOSS / Ian, before 20 Dec): download Lipa's December receipts. Check in Excel that a receipt total matches the POS slip to the centavo and that the row count matches the Z readings.
