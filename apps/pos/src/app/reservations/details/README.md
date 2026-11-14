# src/app/reservations/details contract

## Overview

Selected reservation detail, payments and seating handoff.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/reservations/details`.

## Invariants

- Store plus reservation ID are required to subscribe.
- Missing reservations render a readable not-found state.

## Side Effects

- Subscribes/updates the store reservation, opens payment/void dialogs and passes seating details to cashier through sessionStorage.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (13191 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
