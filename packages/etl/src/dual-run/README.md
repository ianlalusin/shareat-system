# Dual-run comparison engines

## Overview

Pure store-week extraction, key maps, document matching, difference classification and sign-off verdict calculations.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [amount.ts](./amount.ts): includes `parseAmount`.
- [classes.ts](./classes.ts): includes `ClassFamily`, `ClassEntry`, `CLASS_CATALOGUE`, `ClassCode`, `DISPOSITION_CLASSES`, `DispositionClass`.
- [compare.ts](./compare.ts): includes `V2Line`, `CompareDoc`, `Disposition`, `CompareInput`, `Verdict`, `ResultItem`, `ResultDay`, `ResultLine`, `StoreWeekResult`, `compareStoreWeek`.
- [docs.ts](./docs.ts): includes `normaliseReceiptNo`, `v1Documents`.
- [keys.ts](./keys.ts): includes `KeySection`, `KeyRow`, `V2KeyCatalogue`, `STAFF_CASH_KEY`, `serialiseKeysCsv`, `parseKeysCsv`, `prefillKeys`, `assertStoresTicked`, `assertNoStaffCashRow`.
- [snapshot.ts](./snapshot.ts): includes `SnapshotStore`, `ExcludedStore`, `SnapshotLeg`, `SnapshotExpensePayment`, `SnapshotExpense`, `SnapshotSalesDay`, `SnapshotChannel`, `SnapshotReceipt`, `SnapshotSupplier`, `SnapshotPaymentAccount`, `V1Snapshot`, `buildSnapshot`.
- [verdict.ts](./verdict.ts): includes `SignOffPack`, `signOffPack`.
- [week.ts](./week.ts): includes `normaliseBusinessDate`, `addDays`, `weekStartOf`, `datesInWeek`, `manilaDateOf`.

## Invariants

- Compare business-date strings in the Manila calendar; delta is v2 minus v1 in integer centavos.
- Class codes come from the closed CLASS_CATALOGUE; do not classify by matching report prose.
- Name-based key suggestions never tick an answer automatically. Preserve rows the operator already answered.
- Comparison is deterministic and does not post accounting corrections. Persistence and disposition authorization live in the domain layer.

## Side Effects

- Computes in-memory snapshots, hashes, CSV text and comparison results. Database reads/writes and file lifecycle are owned by callers.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
- Contract scan samples entry/schema files first (50 KB per directory, at most 300 lines per implementation); consult the owning source before changing an unlisted operation.
