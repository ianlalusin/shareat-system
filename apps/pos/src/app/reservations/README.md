# src/app/reservations contract

## Overview

Reservation list/calendar route.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/reservations`; `ReservationsPage`.
- [details](./details/README.md) — Selected reservation detail, payments and seating handoff.

## Invariants

- The role guard allows admin/manager/cashier.

## Side Effects

- Mounts ReservationsClient with its live booking queries and actions.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (322 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
