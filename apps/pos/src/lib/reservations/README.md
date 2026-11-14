# src/lib/reservations contract

## Overview

Reservation event/status presentation and one-shot seating handoff to cashier.

## Interface

- [history.ts](./history.ts) — `EVENT_LABEL`, `reservationEvent`, `appendReservationEvent`.
- [seat-handoff.ts](./seat-handoff.ts) — `ReservationSeatHandoff`, `setReservationSeatHandoff`, `takeReservationSeatHandoff`.
- [status.ts](./status.ts) — `STATUS_META`, `OPEN_STATUSES`.

## Invariants

- Open statuses are booked and confirmed.
- The seating handoff is consumed from sessionStorage and carries reservation/party data into cashier.

## Side Effects

- Writes/removes a tab-local sessionStorage handoff; event/status helpers build values for callers.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 3 direct source files (3101 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
