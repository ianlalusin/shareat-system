# src/components/cashier contract

## Overview

Cashier approval, handover, targets/tips, chat and session-header/add-on presentation.

## Interface

- [chat-types.ts](./chat-types.ts) — `ChatThread`, `ChatMessage`.
- [ApprovalQueue.tsx](./ApprovalQueue.tsx) — `ApprovalQueue`.
- [CardPill.tsx](./CardPill.tsx) — `CardPill`.
- [CashHandoverClient.tsx](./CashHandoverClient.tsx) — `CashHandoverClient`.
- [CashierTargetProgressCard.tsx](./CashierTargetProgressCard.tsx) — `CashierTargetProgressCard`.
- [CashierTipController.tsx](./CashierTipController.tsx) — `CashierTipController`.
- [CashierTipModal.tsx](./CashierTipModal.tsx) — `CashierTipModal`.
- [addons-launcher-button.tsx](./addons-launcher-button.tsx) — `AddonsLauncherButton`.
- [session-header.tsx](./session-header.tsx) — `SessionHeader`.

## Invariants

- Approval/history subscriptions are store-scoped.
- Handover attempts preserve the saved request across reloads.
- Target/tip displays read live daily analytics.

## Side Effects

- Subscribes to Firestore, updates approval records, manages handover storage/submission and runs tip timers.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 9 direct source files (49772 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `ChatInbox.tsx`, `ChatThreadPane.tsx`, `ConvertSheet.tsx`, `LinkCardDialog.tsx`, `LoyaltyRedeemCard.tsx`, `ParkWalkInModal.tsx`, `SessionCardBanner.tsx`, `StatutoryDinersPanel.tsx`, `SyncSessionsTool.tsx`, `WaitlistCard.tsx`, `active-sessions-grid.tsx`, `activity-log.ts`, `bill-adjustments.tsx`, `bill-totals.tsx`, `billable-items.tsx`, `chat-utils.ts`, `convert-sheet-logic.ts`, `customer-info-form.tsx`, `edit-billable-item-dialog.tsx`, `family-order-modal.tsx`, `firestore.ts`, `modifier-picker.tsx`, `offlinePayment.ts`, `offlineVoid.ts`, `past-sessions-card.tsx`, `payment-modal.tsx`, `paymongo-qr-view.tsx`, `quantity-input.tsx`, `session-detail-view.tsx`, `session-list-view.tsx`, `start-session-form.tsx`, `statutory-presets.ts`, `target-edit-dialog.tsx`, `void-session-dialog.tsx`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
