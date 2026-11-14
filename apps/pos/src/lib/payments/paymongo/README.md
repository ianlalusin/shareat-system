# src/lib/payments/paymongo contract

## Overview

Predicates deciding whether a method uses PayMongo QR and whether that option should be offered.

## Interface

- [gateway.ts](./gateway.ts) — `isPaymongoQrMethod`, `shouldOfferPaymongoQr`.

## Invariants

- Non-gateway methods retain upstream eligibility rules.
- Gateway availability is evaluated from the provided method and feature inputs.

## Side Effects

- No network or storage calls in the inspected predicates.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (399 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
