# src/components/shared contract

## Overview

App-wide offline/outbox sync, warnings, X-slip scheduler, add-on modal and Android back handling.

## Interface

- [AddonsPOSModal.tsx](./AddonsPOSModal.tsx) — module implementation; exports may occur beyond the bounded source excerpt.
- [AndroidBackHandler.tsx](./AndroidBackHandler.tsx) — `AndroidBackHandler`.
- [Numpad.tsx](./Numpad.tsx) — `Numpad`.
- [OfflineBanner.tsx](./OfflineBanner.tsx) — `OfflineBanner`.
- [OutboxSync.tsx](./OutboxSync.tsx) — `OutboxSync`.
- [PaymentQueueSyncProvider.tsx](./PaymentQueueSyncProvider.tsx) — `PaymentQueueSyncProvider`.
- [ProofOutboxSync.tsx](./ProofOutboxSync.tsx) — `ProofOutboxSync`.
- [UnsentBanner.tsx](./UnsentBanner.tsx) — `UnsentBanner`.
- [WeatherLoggerModal.tsx](./WeatherLoggerModal.tsx) — `WeatherLoggerModal`.
- [XSlipScheduler.tsx](./XSlipScheduler.tsx) — `XSlipScheduler`.

## Invariants

- Unsent warnings do not block selling.
- Reconcile runs at start/online transitions and periodically while online.
- Offline X-slip schedule state is durable and distinguishes already printed intervals.

## Side Effects

- Runs reconcile/effect/proof drains, timers and native-back/browser listeners.
- Add-on/weather workflows use Firestore; printing is delegated to shared transports.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 10 direct source files (35693 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
