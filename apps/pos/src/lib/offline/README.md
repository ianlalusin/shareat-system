# src/lib/offline contract

## Overview

Local-first write helpers, device identity, offline tender rules, ownership fields and deferred-effect replay.

## Interface

- [addon-line.ts](./addon-line.ts) — `stageOfflineAddonLine`.
- [browserDevice.ts](./browserDevice.ts) — `getBrowserDeviceId`.
- [commit.ts](./commit.ts) — `Committable`, `commitLocalFirst`.
- [device.ts](./device.ts) — `KVStore`, `getDeviceId`.
- [kitchenTicketWrites.ts](./kitchenTicketWrites.ts) — `TicketWriter`, `selectTicketWriter`.
- [offlinePaymentSummary.ts](./offlinePaymentSummary.ts) — `PaymentInput`, `MopInput`, `PaymentSummary`, `buildOfflinePaymentSummary`.
- [offlineRules.ts](./offlineRules.ts) — `NEEDS_INTERNET`, `OFFLINE_REFUND_MESSAGE`, `OFFLINE_VOID_ROLE_MESSAGE`, `OWNER_OTHER_TABLET_MESSAGE`, `OfflineMop`, `OfflineTenderRule`, `offlineTenderRule`, `OfflinePaymentInput`, `buildOfflineTenders`, `tendersToCheck`, `canRefundOffline`, `canVoidOffline`, `assertOfflineVoidAllowed`, `assertOfflineSessionOwner`.
- [payment-queue.ts](./payment-queue.ts) — `DeferredEffect`, `EffectState`, `QueuedReceiptContext`, `QueuedPayment`, `pendingEffects`, `markEffect`, `isItemComplete`.
- [replayDeferredEffects.ts](./replayDeferredEffects.ts) — `ReplayDeps`, `VOID_DROP_GRACE_MS`, `replayDeferredEffects`.
- [sessionOwnership.ts](./sessionOwnership.ts) — `sessionOwnershipFields`.

## Invariants

- Offline refunds require internet; offline tender eligibility is explicit.
- A tablet-owned session retains its device/revision fields.
- Deferred-effect shapes are pure here; queue persistence lives in the outbox child boundary.

## Side Effects

- Stages Firestore batches, persists device identity via supplied key/value storage, and replays HTTP effects through dependencies.
- Pure validation helpers calculate tender/change and gate offline operations.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 10 direct source files (16480 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
