# src/lib/analytics contract

## Overview

Receipt/KDS contribution math and adapters for client and server-first analytics deltas.

## Interface

- [applyAnalyticsDeltaV2.ts](./applyAnalyticsDeltaV2.ts) — `getApplicablePresets`, `applyAnalyticsDeltaV2`.
- [applyKdsDeltaServerFirst.ts](./applyKdsDeltaServerFirst.ts) — `KdsActor`, `applyKdsDeltaServerFirst`.
- [applyKdsTicketDelta.ts](./applyKdsTicketDelta.ts) — `applyKdsTicketDelta`.
- [applyReceiptDeltaServerFirst.ts](./applyReceiptDeltaServerFirst.ts) — `ReceiptDeltaOp`, `applyReceiptDeltaServerFirst`.
- [daily.ts](./daily.ts) — `getDayStartMs`, `getManilaHour`, `getManilaDayOfWeek`, `getDayIdFromTimestamp`, `dailyAnalyticsDocRef`, `SessionModeKey`, `modeKeyOf`, `getPaymentContribution`, `getGuestCoversContribution`, `getSalesContribution`.
- [kdsTargets.ts](./kdsTargets.ts) — `KdsTicketLike`, `kdsServingUnits`, `KdsTargets`, `computeKdsTargets`, `kdsEventDayId`.

## Invariants

- Client analytics writers require an injected transaction or batch.
- Receipt delta routing uses the POS2 analytics flag; production otherwise retains the legacy endpoint.
- Measured/weight KDS quantities count as one serving instead of grams or kilograms.

## Side Effects

- Writes analytics through supplied Firestore writers and sends retrying HTTP delta requests.
- Pure date/contribution helpers calculate Manila day/hour and contribution targets.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 6 direct source files (41458 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
