# Dual Run
## Overview
The dual-run comparator for cutover (T-392): compares a v1 snapshot against the v2 ledger and stores one report version per (store, week). It owns running the compare, recording human dispositions on deltas, and reading the overview, week and go/no-go pack screens.

## Interface
- `index.ts`: `RunDualRunInput`, `RunDualRunLine`, `RunDualRunWeek`, `RunDualRunResult`, `runDualRun`.
- `dispositions.ts`: `DualRunKindName`, `DISPOSITION_CLASS_OPTIONS` (`V1_DEFECT`, `V2_DEFECT`), `DispositionClassName`, `RecordDualRunDispositionInput`, `isDispositionableLine`, `mayRecordDualRunDisposition`, `recordDualRunDisposition`.
- `pack.ts`: `DualRunOverviewRow`, `dualRunOverview`, `WeekDispositionView`, `WeekLineView`, `WeekVersionView`, `DualRunWeekView`, `dualRunWeekView`, `DualRunPack`, `dualRunPack`.

## Invariants
- `runDualRun` authorizes `run_cutover` first; refusals needing no lock (keys sheet, store mapping) come before anything else. Per (week, store) it locks (apply only), reads v2, compares, checks staleness, and writes NOTHING until all weeks pass; then inserts report versions with lines and one audit row. `apply: false` is a dry run that writes nothing.
- Reports are append-only versions; an identical week returns status `unchanged`. v1 values that are not whole centavos are reported as warnings, never rounded.
- `recordDualRunDisposition` gate (checked in the domain, not just the UI): `run_cutover`, `view_financial_reports` at the line's store, and an active `admin`/`super_admin` role. It is append-only and takes effect at the next compare run.
- The delta is never an input: `deltaAt` is the CURRENT version's line delta read from the database. Zero-delta lines and lines settled as `TIES`, `INVENTORY_BASIS`, `SUPPLIER_ADVANCE_1240`, `UNMAPPED_KEY` (or `sales_tender`/`none`) are refused. It takes the same per-store-week advisory lock as the run.
- `recordDualRunDisposition` is exported from `packages/domain/src/index.ts` directly and NEVER from `dual-run/index.ts` (the CLI imports that barrel and has no classify subcommand).
- Reads authorize `view_financial_reports`; `dualRunPack` authorizes EVERY active store (and any store with reports), so a partly-scoped actor is refused and a subset can never read `signable`. Sign-off thresholds: `MIN_TOTAL_DAYS = 15`, `MIN_STORE_DAYS = 10`, counting only current versions whose verdict is not `no_data`.
- The pure comparator is imported from `packages/etl/src/dual-run` by relative path (a package import would be a cycle). Money is centavos in code, 2dp strings out.

## Side Effects
- `runDualRun`: with `tx` null opens an org-scoped transaction (`withOrgPrincipal`); on apply, takes advisory locks, inserts reports and lines (`dualRunRepo`), appends an `audit_log` row; uses `node:crypto` (sha256, `randomUUID`) and parses the snapshot's `extractedAt` into a `Date`.
- `recordDualRunDisposition`: takes a lock, inserts a disposition, appends audit action `dual_run.disposition`.
- `pack.ts` and `mayRecordDualRunDisposition`: read-only database reads.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
