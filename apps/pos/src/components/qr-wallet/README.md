# src/components/qr-wallet contract

## Overview

Saved-QR add/edit, camera scan, customer display and wallet dialogs.

## Interface

- [AddQrDialog.tsx](./AddQrDialog.tsx) — `AddQrDialogProps`, `AddQrDialog`.
- [QrDisplayModal.tsx](./QrDisplayModal.tsx) — `QrDisplayModal`.
- [QrScanner.tsx](./QrScanner.tsx) — `QrScanner`.
- [QrTileIcon.tsx](./QrTileIcon.tsx) — `QrTileIcon`.
- [QrWalletModal.tsx](./QrWalletModal.tsx) — `QrWalletModalProps`, `QrWalletModal`.

## Invariants

- Camera support is checked before requesting a stream.
- QR parsing/selection and image processing are delegated to shared helpers.

## Side Effects

- Starts/stops camera scanning, writes QR documents/storage assets and opens display/editor dialogs.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 5 direct source files (39851 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
