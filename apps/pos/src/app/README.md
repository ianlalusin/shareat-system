# src/app contract

## Overview

Next.js root layout, providers and login landing page, plus floor routes and POS2 endpoints.

## Interface

- [layout.tsx](./layout.tsx) — `metadata`, `viewport`, `RootLayout`.
- [not-found.tsx](./not-found.tsx) — `NotFound`.
- [page.tsx](./page.tsx) — Next.js page for `/`; `RootPage`.
- [providers.tsx](./providers.tsx) — `Providers`.
- [account](./account/README.md) — Staff account/security screen.
- [api](./api/README.md) — Boundary index for pos2.
- [cashier](./cashier/README.md) — Cashier session list/detail route selected by the sessionId query.
- [change-password](./change-password/README.md) — Forced password-change form after an administrator reset.
- [forgot-password](./forgot-password/README.md) — Email password-reset request screen.
- [kitchen](./kitchen/README.md) — Live station-based kitchen display.
- [login](./login/README.md) — Firebase email/password sign-in screen.
- [online-orders](./online-orders/README.md) — Online-order management route.
- [pending](./pending/README.md) — Pending-account approval notice.
- [pins](./pins/README.md) — Session/customer PIN listing and issue/finalize controls.
- [print](./print/README.md) — Boundary index for session-pin.
- [receipt](./receipt/README.md) — Single-receipt preview and 58/80mm printing.
- [receipts](./receipts/README.md) — Receipt history with date filters, paging and refund/correction dialog state.
- [refill](./refill/README.md) — Compatibility redirect to the server floor screen.
- [reservations](./reservations/README.md) — Reservation list/calendar route.
- [server](./server/README.md) — Client-loaded server floor workflow.
- [settings](./settings/README.md) — Printer/device settings with Bluetooth/USB and terminal/outbox controls.
- [signup](./signup/README.md) — Account creation followed by required staff details.
- [support](./support/README.md) — Support notice and return-to-login link.

## Invariants

- Providers install the APK API-base shim in a mount effect.
- Service-worker registration is browser-only and is skipped for the native app.

## Side Effects

- Providers register `/sw.js`, listen for resume events and mount shared state/synchronization providers.
- The landing page renders LoginPage.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (6175 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
