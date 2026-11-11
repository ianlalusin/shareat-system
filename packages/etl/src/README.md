# Migration analysis and replay source

## Overview

Legacy taxonomy, capture, conversion and reconciliation APIs, with balance audit, master-data planning and dual-run engines.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [capture.ts](./capture.ts): includes `CaptureCredentials`, `CaptureSkipped`, `FileReader`, `loadCaptureCredentials`, `CaptureCandidate`, `FirestoreReader`, `Classifier`, `SampledSpecimen`, `CaptureRunResult`, `sampleCandidates`, `runCapture`.
- [convert.ts](./convert.ts): includes `SalesDayStatus`, `SalesDayDoc`, `ExpensePaymentMethod`, `ExpensePaymentSplit`, `ExpenseEntryGroup`, `ExpenseDoc`, `SpecimenKind`, `RawSpecimen`, `ConvertedLine`, `ConvertedEntry`, `ConversionStatus`, `REASON_CODES`.
- [leg-mapping.ts](./leg-mapping.ts): includes `ACCOUNTS`, `COGS_CATEGORY_ACCOUNTS`, `COGS_INVENTORY_ACCOUNTS`, `OPEX_CATEGORY_ACCOUNTS`, `AMBIGUOUS_CATEGORY_FINDINGS`, `SourceTypeClass`, `SourceTypeMapping`, `SOURCE_TYPE_MAPPINGS`.
- [report.ts](./report.ts): includes `CoverageStatus`, `CoverageRow`, `buildCoverageReport`, `formatCoverageReport`, `ConversionSummary`, `summarizeConversions`, `formatConversionSummary`.
- [audit](./audit/README.md): Reconstructs landed journal balances, cross-checks v1 cached accounts, classifies source groups and renders the resulting audit report.
- [dual-run](./dual-run/README.md): Pure store-week extraction, key maps, document matching, difference classification and sign-off verdict calculations.
- [master-data](./master-data/README.md): Read-only extraction boundary and planners for item, party and staff decision sheets, including local HR validation.

## Invariants

- @shareat/etl has no Firebase SDK dependency: readers are injected and the provider adapter is a separate package.
- Legacy account/wire translation belongs at this boundary; v1 data is evidence and must not silently overwrite authoritative rebuilt state.
- Capture credentials are explicit inputs; preserve named skip/quarantine/findings outcomes instead of coercing bad data into successful conversions.

## Side Effects

- Pure conversion and reporting functions transform inputs; capture invokes the caller-provided reader.
- The run/reconciliation APIs coordinate database landing, quarantine and reconciliation through @shareat/db and posting through domain APIs.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
- Contract scan samples entry/schema files first (50 KB per directory, at most 300 lines per implementation); consult the owning source before changing an unlisted operation.
