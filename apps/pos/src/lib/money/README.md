# src/lib/money contract

## Overview

Centavo conversion, exact rational bill stages, display formatting and refund-share allocation.

## Interface

- [centavos.ts](./centavos.ts) — `getNonCentavoCount`, `resetNonCentavoCount`, `roundHalfUp`, `storedPesosToCentavos`, `parsePesoInput`, `allocate`, `allocateExact`, `toWirePesos`, `roundMoney`.
- [exact.ts](./exact.ts) — `Exact`, `ZERO`, `ONE`, `HUNDRED`.
- [format.ts](./format.ts) — `formatCentavos`.
- [line-amounts.ts](./line-amounts.ts) — `lineAmounts`.
- [ordinary-bill.ts](./ordinary-bill.ts) — `ordinaryBill`.
- [refundShare.ts](./refundShare.ts) — `ShareLine`, `netQtyOf`, `paidShares`, `unitsRefundCentavos`.

## Invariants

- Internal money uses integer centavos; wire peso conversion is centralized.
- Exact bill stages use BigInt fractions and half-up rounding at explicit boundaries.
- Refund units consume the line share of the amount actually paid.

## Side Effects

- Math helpers return calculated values; the centavo module also maintains a diagnostic non-centavo counter.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 6 direct source files (16151 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
