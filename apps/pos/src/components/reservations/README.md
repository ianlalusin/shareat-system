# src/components/reservations contract

## Overview

Booking form, payment/void modals and reservation list/calendar client.

## Interface

- [ReservationFormModal.tsx](./ReservationFormModal.tsx) — `ReservationFormModal`.
- [ReservationPaymentModal.tsx](./ReservationPaymentModal.tsx) — `ReservationPaymentModal`.
- [ReservationPaymentVoidModal.tsx](./ReservationPaymentVoidModal.tsx) — `ReservationPaymentVoidModal`.
- [ReservationsClient.tsx](./ReservationsClient.tsx) — `ReservationsClient`.

## Invariants

- Edits and payments target the selected store reservation.
- Payment voids run transactionally instead of blind array replacement.

## Side Effects

- Subscribes/creates/updates reservation documents, appends payment/events and navigates via the seating handoff.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (34766 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
