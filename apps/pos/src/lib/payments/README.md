# src/lib/payments contract

## Overview

Boundary index for paymongo, proof.

## Interface

- [paymongo](./paymongo/README.md) — Predicates deciding whether a method uses PayMongo QR and whether that option should be offered.
- [proof](./proof/README.md) — Captures payment-proof metadata and queues image uploads in an IndexedDB photo outbox.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- Non-gateway methods retain upstream eligibility rules.
- Gateway availability is evaluated from the provided method and feature inputs.
- Proof metadata is written through Firestore persistence; photo bytes use a separate durable outbox.

## Side Effects

- Child boundary behavior: No network or storage calls in the inspected predicates.
- Child boundary behavior: Writes paymentProofs documents, uploads to Firebase Storage and enqueues/removes/retries IndexedDB photo records.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
