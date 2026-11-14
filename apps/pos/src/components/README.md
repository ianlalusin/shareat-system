# src/components contract

## Overview

Shared page header and Firebase permission-error listener, with floor-specific component families.

## Interface

- [FirebaseErrorListener.tsx](./FirebaseErrorListener.tsx) — `FirebaseErrorListener`.
- [page-header.tsx](./page-header.tsx) — `PageHeader`.
- [account](./account/README.md) — Password-change dialog.
- [admin](./admin/README.md) — Boundary index for online-orders.
- [auth](./auth/README.md) — First-login password-change guard.
- [cashier](./cashier/README.md) — Cashier approval, handover, targets/tips, chat and session-header/add-on presentation.
- [dashboard](./dashboard/README.md) — Floating entry point for weather logging.
- [global](./global/README.md) — Promise-based confirmation dialog hook.
- [guards](./guards/README.md) — Client RoleGuard and role-home routing.
- [kitchen](./kitchen/README.md) — Kitchen ticket cards/views, assistance alerts and synchronization tool.
- [layout](./layout/README.md) — Application shell, navigation, store switcher and local-user/QR-wallet entry points.
- [pins](./pins/README.md) — Customer administration and legacy-loyalty-points panel.
- [pos2](./pos2/README.md) — Six-digit manager approval PIN pad.
- [qr-wallet](./qr-wallet/README.md) — Saved-QR add/edit, camera scan, customer display and wallet dialogs.
- [receipt](./receipt/README.md) — Receipt preview/print markup.
- [receipts](./receipts/README.md) — Manager-approved refund and tender-correction dialogs.
- [reservations](./reservations/README.md) — Booking form, payment/void modals and reservation list/calendar client.
- [server](./server/README.md) — Server tables, guest verification, refill ordering and device-local profile controls.
- [session](./session/README.md) — Session timeline drawer.
- [settings](./settings/README.md) — Terminal setup and outbox/updates/X-slip settings sections.
- [shared](./shared/README.md) — App-wide offline/outbox sync, warnings, X-slip scheduler, add-on modal and Android back handling.
- [ui](./ui/README.md) — Reusable Radix/React presentation primitives, loader and compact calendar.

## Invariants

- PageHeader receives title/description/content props.
- FirebaseErrorListener responds to the shared permission-error emitter rather than polling Firestore.

## Side Effects

- The listener can throw an emitted permission error into the React error boundary; children own subscriptions and writes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (2540 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
