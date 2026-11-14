# src/server/pos2 contract

## Overview

Server ports and protected handlers for analytics, refunds, conversions and related manager-approved POS operations.

## Interface

- [types.ts](./types.ts) — `Pos2Db`, `ApprovalResult`, `Pos2Deps`.
- [apply-delta.ts](./apply-delta.ts) — `handleApplyDelta`.
- [approval.ts](./approval.ts) — `DEVICE_ID_MISSING`, `requireManagerApproval`.
- [conversions.ts](./conversions.ts) — `handleConversion`, `handleConversionVoid`.
- [deps.ts](./deps.ts) — `POS2_NOT_CONFIGURED`, `getPos2Deps`.
- [http.ts](./http.ts) — `jsonResponse`, `fail`, `UNEXPECTED_ERROR`, `isUuid`, `isNonBlank`, `Refusal`, `guarded`, `bodyHash`.
- [identity.ts](./identity.ts) — `Caller`, `authenticate`.
- [payment-conversion.ts](./payment-conversion.ts) — `writeByMethodDelta`.
- [refunds.ts](./refunds.ts) — `CASH_ONLY_MESSAGE`, `handleRefund`.
- [roles.ts](./roles.ts) — `requireRole`.
- [route.ts](./route.ts) — `runPos2Route`.
- [analytics](./analytics/README.md) — Server analytics contribution/delta core shared by the protected apply-delta handler.

## Invariants

- Identity verifies JSON, bearer token and server-side staff/store context before protected work.
- Manager approval validates device/PIN through an injected approval port.
- Refund amount and prior-refund limits are recomputed from server records; client counters are not authority.

## Side Effects

- Builds Firebase Admin/auth dependencies from server configuration and performs Firestore transactions.
- Handlers produce JSON responses; dependency setup can read a configured credential file at runtime (not read during this documentation task).

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 11 direct source files (45698 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `session-voids.ts`, `tender-corrections.ts`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
