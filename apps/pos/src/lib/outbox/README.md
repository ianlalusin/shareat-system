# src/lib/outbox contract

## Overview

Durable sale ledger, deferred effects, reconciliation, offline-period state and unsent-sales/update controls.

## Interface

- [effects-store.ts](./effects-store.ts) — `LEGACY_QUEUE_KEY`, `CORRUPT_QUEUE_KEY`, `migrateLegacyQueue`, `listEffectItems`, `addEffectItem`, `ensureSaleEffectItem`, `updateEffectItem`, `removeEffectItem`, `listRunnableEffectItems`, `listFailedEffectItems`, `retryFailedEffectItem`.
- [ledger.ts](./ledger.ts) — `LedgerKind`, `LedgerStatus`, `LedgerOp`, `LedgerTender`, `LedgerEvent`, `SALE_NOT_SAVED_MESSAGE`, `MAX_ATTEMPTS`, `PRUNE_AFTER_MS`, `SERVER_TIMESTAMP_MARKER`, `deleteFieldMarker`, `arrayRemoveMarker`, `encodeLedgerValue`, `OpsSdk`, `applyOpsToBatch` (additional exports in source).
- [linesHash.ts](./linesHash.ts) — `computeLinesHash`, `legacyClockLinesHash`.
- [offlinePeriod.ts](./offlinePeriod.ts) — `OFFLINE_SLIP_INTERVAL_MS`, `ONLINE_TO_END_MS`, `OfflinePeriodState`, `EMPTY_OFFLINE_PERIOD`, `PeriodObservation`, `PeriodStep`, `advanceOfflinePeriod`, `markSlipsPrinted`, `loadOfflinePeriod`, `saveOfflinePeriod`.
- [outboxStatus.ts](./outboxStatus.ts) — `OutboxStatus`, `readOutboxStatus`, `getOutboxStatus`, `getInitialOutboxStatus`, `subscribeOutboxStatus`, `refreshOutboxStatus`, `notifyOutboxChanged`.
- [reconcile.ts](./reconcile.ts) — `PENDING_WRITES_TIMEOUT_MS`, `CONFLICT_ANOTHER_TABLET`, `ReconcilePort`, `ReconcileLocks`, `ReconcileDeps`, `ReconcileResult`, `runReconcilePass`.
- [reconcileRunner.ts](./reconcileRunner.ts) — `realReconcilePort`, `runReconcileNow`.
- [refusal.ts](./refusal.ts) — `REFUSAL_CODES`, `codeOf`, `messageOf`, `isServerRefusal`, `rejectIfRefused`.
- [unsentBanner.ts](./unsentBanner.ts) — `UNSENT_WARNING_THRESHOLD_CENTAVOS`, `shouldShowUnsentBanner`, `unsentBannerText`.
- [updateGate.ts](./updateGate.ts) — `unsentSalesWarningText`, `canShowUpdateLink`, `checkForUpdate`.

## Invariants

- Receipt reservation and ledger event data share the terminal IndexedDB database.
- Acknowledged means server proof via a cache-bypassing read; a cache success is insufficient.
- Permanent server refusals are retained as rejected records; conflicts are quarantined rather than overwritten.

## Side Effects

- Persists ledger/effects/meta records, migrates the legacy localStorage queue, and runs server reads/guarded replays.
- Publishes outbox state and probes the health endpoint for safe update availability.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 10 direct source files (48583 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `xSlipRun.ts`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
