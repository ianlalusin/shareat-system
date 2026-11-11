# src contract

## Overview

POS source entry point with APK API CORS middleware and the application, component, state and service boundaries.

## Interface

- [middleware.ts](./middleware.ts) — `middleware`, `config`.
- [app](./app/README.md) — Next.js root layout, providers and login landing page, plus floor routes and POS2 endpoints.
- [components](./components/README.md) — Shared page header and Firebase permission-error listener, with floor-specific component families.
- [context](./context/README.md) — Application providers for authenticated staff, active store, device-local profile and the QR wallet.
- [firebase](./firebase/README.md) — Firebase initialization, React SDK providers, typed error events and non-blocking auth/document helpers.
- [hooks](./hooks/README.md) — React adapters for connectivity, deferred payments, printing, receipt settings, device status and floor data.
- [lib](./lib/README.md) — Shared POS wire types, API routing, tax/bill calculations and small display/selection helpers, with specialized child services.
- [server](./server/README.md) — Boundary index for pos2.
- [test-helpers](./test-helpers/README.md) — POS test adapters and fixture builders for fake clocks, Firestore, IndexedDB, POS2 handlers and outbox scenarios.

## Invariants

- Middleware matches `/api/:path*` and handles the Capacitor origin; this is separate from handler authentication.
- UI, client utilities and server handlers remain distinct child boundaries.

## Side Effects

- Middleware constructs HTTP responses and CORS headers; descendants own persistence and device effects.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (1360 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
