# src/lib/kitchen contract

## Overview

Pure billing/served-quantity helpers, server-clock correction and SLA thresholds.

## Interface

- [customer-order-billing.ts](./customer-order-billing.ts) — `PendingBillLineModifier`, `PendingBillLine`, `pendingBillLineFor`, `shouldVoidBilledQty`, `buildCustomerOrderBillLine`.
- [served-qty.ts](./served-qty.ts) — `ServedQtyTicket`, `servedQtyFields`.
- [server-clock.ts](./server-clock.ts) — `MAX_USEFUL_ROUND_TRIP_MS`, `clientAheadFromSample`, `serverNowMs`, `resolveTicketStartMs`, `ticketAgeMs`.
- [sla.ts](./sla.ts) — `DEFAULT_SLA_MINUTES`, `DEFAULT_SLA_MS`, `isServeLate`, `isServeVeryLate`.

## Invariants

- Customer-order billing requires `billOnServe` and a valid pending bill line.
- Server-clock samples reject nonfinite values and round trips over ten seconds.
- Ticket age uses corrected server time rather than mixing device clocks.

## Side Effects

- Returns billing, quantity, time and SLA values without issuing Firestore writes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (11721 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
