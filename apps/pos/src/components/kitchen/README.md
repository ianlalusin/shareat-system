# src/components/kitchen contract

## Overview

Kitchen ticket cards/views, assistance alerts and synchronization tool.

## Interface

- [AssistanceAlerts.tsx](./AssistanceAlerts.tsx) — `AssistanceAlerts`.
- [SyncKdsTicketsTool.tsx](./SyncKdsTicketsTool.tsx) — `SyncKdsTicketsTool`.
- [history-view.tsx](./history-view.tsx) — `HistoryView`.
- [kds-flash-overlay.tsx](./kds-flash-overlay.tsx) — `KdsFlashOverlay`.
- [kds-item-card.tsx](./kds-item-card.tsx) — `ServeBatchPayload`, `CancelRemainingPayload`, `KdsItemCard`, `DEFAULT_SLA_MINUTES`.
- [kds-view.tsx](./kds-view.tsx) — `KdsView`.
- [history](./history/README.md) — Kitchen ticket-history client with filters and paging.

## Invariants

- Cards use shared SLA and corrected-clock helpers for age.
- Assistance alerts remain actionable until resolved.

## Side Effects

- Creates Firestore listeners/status writes, timers and audio/flash feedback; the sync tool batches ticket repairs.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 6 direct source files (39519 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
