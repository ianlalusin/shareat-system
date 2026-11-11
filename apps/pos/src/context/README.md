# src/context contract

## Overview

Application providers for authenticated staff, active store, device-local profile and the QR wallet.

## Interface

- [auth-context.tsx](./auth-context.tsx) — `AppUser`, `AuthContextProvider`, `useAuthContext`.
- [local-profile-context.tsx](./local-profile-context.tsx) — `LocalProfileProvider`, `useLocalProfile`.
- [qr-wallet-context.tsx](./qr-wallet-context.tsx) — `QrWalletProvider`, `useQrWallet`.
- [store-context.tsx](./store-context.tsx) — `collectMissingImageProductIds`, `chunkIds`, `applyInheritedImages`, `resolveProductImages`, `StoreContextProvider`.

## Invariants

- Authentication is resolved from Firebase and the staff document; role state is not a form argument.
- The local-profile selector and QR-wallet dialogs have one provider owner.
- Active store state is persisted and store configuration is loaded for that store.

## Side Effects

- Subscribes to staff/store documents, persists the selected store in localStorage and writes QR-wallet audit events.
- Provider actions sign out or switch client state and control mounted dialogs.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (24659 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
