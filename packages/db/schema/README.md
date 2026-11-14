# Relational schema

## Overview

Drizzle table, enum-like constant and view typings for the shared PostgreSQL model, exported through schema/index.ts.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [access.ts](./access.ts): includes `personRoles`, `personStoreScope`, `personGrants`.
- [accounts.ts](./accounts.ts): includes `accounts`.
- [ap-payments.ts](./ap-payments.ts): includes `AP_PAYMENT_STATUSES`, `ApPaymentStatus`, `apPayments`, `apPaymentAllocations`.
- [ar.ts](./ar.ts): includes `AR_DOC_STATUSES`, `ArDocStatus`, `arCharges`, `arCollections`, `arCollectionAllocations`, `arWriteOffs`.

## Invariants

- Schema builders describe what Drizzle can express; hand-authored migrations install constraints, functions, policies and views that require SQL.
- Any new table must also be classified for cutover and registered for RLS.
- Keep exact numeric precision/scale, declared account polarity and same-org foreign-key rules; do not substitute floating types or inferred balances.

## Side Effects

- Importing schema declarations constructs metadata, without connecting or applying DDL. Migrations create and alter the corresponding database objects.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
- Contract scan samples entry/schema files first (50 KB per directory, at most 300 lines per implementation); consult the owning source before changing an unlisted operation.
