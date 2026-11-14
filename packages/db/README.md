# PostgreSQL data layer

## Overview

Relational schema, lazy clients, repository SQL, reference-data seeds and hand-authored migration runner.

## Interface

- `@shareat/db` exports: `.` → `./src/index.ts`, `./schema` → `./schema/index.ts`, `./pos-v1/wire` → `./src/pos-v1/wire.ts`, `./client` → `./src/client.ts`.
- [migrations](./migrations/README.md): Forward-only SQL history, journal ordering and migration authoring checklist.
- [schema](./schema/README.md): Drizzle table, enum-like constant and view typings for the shared PostgreSQL model, exported through schema/index.ts.
- [seed](./seed/README.md): Declared chart of accounts and expense categories plus functions that insert their missing rows for an organization.
- [src](./src/README.md): Lazy PostgreSQL clients, explicit transaction lanes, shared refusal primitives and the public repository barrel.

## Invariants

- Schema changes are forward-only migrations; db:generate deliberately fails closed.
- Every table needs cutover and RLS classification; repositories retain org/store filters alongside database enforcement.

## Side Effects

- Runtime clients and repositories read/write/lock PostgreSQL. Running db:migrate applies journaled SQL; db:studio opens a database inspection tool.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
