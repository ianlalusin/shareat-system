# src/components/layout contract

## Overview

Application shell, navigation, store switcher and local-user/QR-wallet entry points.

## Interface

- [AppLayout.tsx](./AppLayout.tsx) — `AppLayout`.
- [header.tsx](./header.tsx) — `Header`.
- [local-user-nav-button.tsx](./local-user-nav-button.tsx) — `LocalUserNavButton`.
- [main-nav.tsx](./main-nav.tsx) — `MainNav`.
- [qr-wallet-nav-button.tsx](./qr-wallet-nav-button.tsx) — `QrWalletNavButton`.
- [store-switcher.tsx](./store-switcher.tsx) — `StoreSwitcher`.
- [user-nav.tsx](./user-nav.tsx) — `UserNav`.

## Invariants

- The shell combines account identity with local-profile attribution.
- Navigation order badges derive from outstanding online-order statuses.

## Side Effects

- Subscribes to order counts, changes active store/profile/dialog state and navigates between floor screens.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 7 direct source files (23320 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
