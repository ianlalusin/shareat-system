# T-472: Nightly per-receipt bridge — copy every POS receipt from Firebase into Postgres (from 1 Jan 2027)

**Status:** spec written 2026-10-23 (Opus planner, POS v2 session); revised the same day after the orchestrator's
Opus review. Waits on Ian: Q1 (create the read-only service account), Q4 confirm, Ruling 7 re-confirm. Orchestrator: migration 0215 allocated, file list OK (23 Oct).
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor (schema + money: Sonnet, never Haiku).
**Migration:** ONE, hand-authored (ADR-012 §5 checklist); number from the orchestrator (0212+ is theirs).
**Authority:** bible rows 272, 276, 307, 379 (clean slate; nightly per-receipt bridge from 1 Jan 2027, all stores,
read-only on Firebase, extends T-396; a store leaves the bridge when P2 moves its receipts), 390 (Z to Z) ·
RULES #6 (no float money) · ADR-012 · T-396 (06:00 day import) · T-435 (personal-data gates).

## Goal, in plain words
Every night the server copies each receipt the stores rang the day before (lines, payments, discounts, voids,
refunds) from POS's Firebase into our own database. Nothing in POS changes and nothing is posted to the books:
it is a faithful, read-only copy so the ERP can check its daily totals against real receipts, and later derive
stock use and reports from them. It starts with 1 January 2027; older POS data is test data (row 379).

## Facts (survey 23 Oct, origin/main `69dca6c`)
- No receipt-level table exists; the only POS tables are the day feed (`pos_v1_day_feeds`, `sales_days*`),
  links (`pos_v1_store_links`), item maps and usage pulls (`packages/db/schema/pos-v1.ts`, `sales-days.ts`,
  `pos-mapping.ts`).
- No v1 HTTP route returns single receipts (`POS/src/app/api/external/*`); `sold-items` reads
  `stores/{id}/receipts` by `createdAtClientMs` for one Manila day with no cap. v1 is read-only, so no new route.
- The server already holds a read key for the POS Firebase project: `/srv/shareat-shared/secrets/pos2-firebase-key.json`
  (`POS_FIREBASE_SA_KEY_FILE`, `pos2.env`). The T-396 job pattern: `scripts/pos-day-import.ts`,
  `packages/domain/src/pos/day-import-job.ts:112` (catch-up 7 days), `docs/ops/shareat-pos-day-import.{service,timer}`.
- Receipt shape: `apps/pos/src/lib/types.ts:1539-1612` (lines, totals, `status` final|voided + void fields,
  `terminalNo/Seq`, `deviceId`, `isRefund`/`parentReceiptId`, `analytics.mop`, `statutoryDiners` (T-426), customer
  name/TIN/address). Refund docs are `rf-<number>` with a negative total.

## Rulings (revised 23 Oct after the orchestrator's Opus review, `t472-review.md`)
1. **Read Firestore read-only, by structure.** The reader lives in `packages/etl-firestore` (it already has the
   read-only admin client pattern, `src/reader.ts`); `packages/domain` gets it through a port (domain has no
   firebase-admin). It uses its OWN credential: a new service account with only `Cloud Datastore Viewer` on
   project `shareat-hub-v2`, key at `/srv/shareat-shared/secrets/pos-bridge-reader.json` (`POS_BRIDGE_SA_KEY_FILE`).
   Never the POS v2 server key (`pos2-firebase-key.json` can write). A guard test fails if the bridge imports any
   Firestore write call. **Ian creates the service account (Q1).**
2. **Which receipts.** Per linked store and Manila calendar day: `stores/{posStoreId}/receipts` where
   `createdAtClientMs` in the day, paged (500 + cursor); plus a cross-check count by server `createdAt` for docs
   missing `createdAtClientMs` (v1 analytics falls back to it, `POS/src/lib/analytics/daily.ts:156`). Plus
   **change-time queries** since the last successful run on `voidedAt`, `editedAt` and server `createdAt`, so
   voids, in-place edits (v1) and offline syncs older than 7 days are caught (Q4). Calendar day is the key; for a
   v2 store the T-471 Z number is an attribute only (row 390).
3. **Identity and versions.** Key `UNIQUE(org_id, pos_store_id, firestore_doc_id, version)`; never receipt
   number or terminal seq (GLOSSARY: `receiptSeq` is not monotonic). `doc_hash` = `toStableJson` (etl-firestore)
   over a FIXED list of copied fields; housekeeping fields (`analyticsApplied*`, `reRingLinkedAt`, `editedAt` stamps,
   `types.ts:1568-1601`) are excluded so they never mint versions. A new version only when the hash differs from
   the latest; concurrent runs: insert-where-latest-differs, a `23505` counts as skipped (as
   `day-import-job.ts:267`). A doc seen before and missing from a re-read day gets a `gone` version. The current
   view `pos_bridge_receipts_current` is `security_invoker = true`.
4. **Tables (migration 0215).** `pos_bridge_receipts` (header: org, store, pos ids, kind sale|refund, status,
   client time, `pos_calendar_date`, money, `raw` jsonb minus personal fields, hash, version);
   `pos_bridge_receipt_lines`; `pos_bridge_receipt_tenders`; `pos_bridge_day_checks` (Ruling 6). Every child
   table has its OWN `org_id` and a composite FK `(org_id, receipt_id) -> pos_bridge_receipts(org_id, id)` (no
   via-header, no trigger: T-398's pinned counts). The tenders FK target needs `UNIQUE(org_id, id)` on `tenders`,
   added by 0215 (as 0213 did for `pos_v1_day_feeds`). 0215 also rewrites the `scheduler_runs` job CHECK to add
   `pos_receipt_bridge` (as 0209). Cutover class: `date_scoped` on `pos_calendar_date`, keepFrom 2027-01-01.
5. **Money.** Through `moneyFromLegacyFloat` (`packages/core/src/money.ts:286`): store the value and a
   `money_flag` when it was not a whole centavo; never drop a receipt. Tenders matched per receipt with
   `normalizePosV1Alias`; refunds do NOT go through `resolvePosV1Methods` (it rejects negatives and works on day
   totals). Postgres errors from these tables are sanitised before `sentenceOf` (no row values in messages).
6. **Checks, not truth.** No posting, `sales_days` untouched. `pos_bridge_day_checks` holds per store-day: receipt
   count, sum of final sales minus refunds, the day-feed figures, result (match | mismatch | pending when no feed
   yet), recomputed nightly. A mismatch above 1 centavo per receipt shows as one note on the Sales days page.
7. **Personal data (Ian, 23 Oct — being re-confirmed via the orchestrator with one new fact).** Ian chose a
   separate locked table. New fact: `statutory_discount_records` already holds senior/PWD `holder_name` /
   `id_number` (`schema/statutory-discounts.ts:84`) and T-435 has no table-level gate. Until he re-confirms, the
   build copies NO personal fields (customer name/TIN/address, statutory name/ID) and `raw` excludes them; adding
   the table later is additive.
8. **Schedule.** Job `pos_receipt_bridge`, own timer **06:30 Manila**, heartbeat like `POS_IMPORT_HEARTBEAT_URL`.
   The 2027-01-01 floor applies to **writes only**, so the December dry run (`--dry-run`, reads and reports, writes
   nothing) works. Live from 2 Jan for 1 Jan's sales. Volume ~8.4k reads a night, inside the free tier.
9. **Dropped for 1 Jan (scope):** `bridge_until`, `z_reading_no` column, hard-coded store exclusions (stores come
   from live links only; Banay-Banay has none after T-454).

## Rules from the orchestrator (23 Oct; the T-398 guards fail the build otherwise)
- **Migration 0215** (0212 = T-464, 0213/0214 = T-398 S3/S4). Merge main after the T-398 PR lands and before this
  merges, so the journal stays 0211..0215 in order.
- **Same-org FKs (DEF-491):** composite FKs `(org_id, x) -> parent(org_id, id)`; no single-column org-to-org FK
  (census test, `OPEN_DEF_491 = []`). Children: own `org_id` + composite FK (Ruling 4).
- **Transactions (DEF-421, DEF-742):** new domain functions take `tx: Tx` (never `Tx | null`); org writes under
  `withOrgPrincipal`; `systemTransaction` only to list orgs; never a bare `transaction()`.
- **Fixtures (DEF-744):** `employments.staff_code` is `SE-NNN`; no hex-only typed values.

## Files (orchestrator OK'd 23 Oct; T-472 stays with this session)
`packages/db/schema/pos-bridge.ts` (new) · `packages/db/migrations/<NNNN>_pos_receipt_bridge.sql` (new) ·
`packages/db/src/cutover/classification.ts` · `packages/db/src/rls/registry.ts` · `packages/db/src/repo/pos-bridge.ts`
(new) · `packages/domain/src/pos/receipt-bridge-job.ts` (new) · `packages/etl-firestore/src/pos-receipts.ts` (new, read-only reader) · `packages/domain/src/pos/receipt-bridge-port.ts` (new) · `packages/db/schema/scheduler.ts` (job CHECK) · `packages/db/schema/pos-v1.ts` (`UNIQUE(org_id, id)` on `tenders` only) · `scripts/pos-receipt-bridge.ts` (new) ·
`docs/ops/shareat-pos-receipt-bridge.{service,timer}` (new) · the Sales days page note (`apps/erp/src/app/sales-days/*`,
one line) · tests beside each.

## Slices
T (red tests: reader is read-only, day window and paging, money conversion refuses non-centavo, versioning by
hash, 2027 floor, Banay-Banay excluded, checks vs day feed, dry run writes nothing, RLS + classification guards) ·
S1 schema + migration · S2 reader + job · S3 script, units, Sales days note · A auditor (full suite on a fresh gate
DB, migration rule).

## Out of scope
Any write to Firebase; deriving stock use from receipts (later, pull-redesign proposal); P2 ownership move.
