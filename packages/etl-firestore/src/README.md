# Read-only Firestore capture adapter

## Overview

ERP Firestore client initialization, paged source reader and count-first capture-plan execution.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [client.ts](./client.ts): includes `ErpFirestoreClientReady`, `ErpFirestoreClientResult`, `createErpFirestoreClient`.
- [plan.ts](./plan.ts): includes `PlanError`, `CaptureTarget`, `CapturePlan`, `PlanCaptureParams`, `planCapture`, `TargetCount`, `countTargets`, `formatCountTable`, `RunFetchOptions`, `runFetch`, `RunPlanOptions`, `RunPlanResult`.
- [reader.ts](./reader.ts): includes `DEFAULT_PAGE_SIZE`, `FirestoreCountSnapshotLike`, `FirestoreAggregateQueryLike`, `FirestoreDocLike`, `FirestoreQuerySnapshotLike`, `FirestoreQueryLike`, `FirestoreClientLike`, `toStableJson`, `extractStoreCode`, `FirestoreSourceReaderOptions`, `FirestoreSourceReader`.

## Invariants

- Use the capture credential loader and the explicit ERP-project credential contract; do not substitute the production Firebase Admin credential.
- SourceReader exposes reads and counts, with no document-writing API.
- planCapture is pure. Execution counts targets first and fetches documents only on the explicit fetch path.

## Side Effects

- Loads configured credentials and initializes/reuses a Firebase Admin app. Counts and paged reads call the remote Firestore service.
- Capture execution passes fetched documents to the supplied capture/landing workflow; this adapter never writes to source Firestore.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
