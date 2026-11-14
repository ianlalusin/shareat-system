# files

## Overview

Route namespace `/files`. Authenticated upload and purpose-scoped evidence viewing routes.

Parent blueprint: [up one directory](../README.md).

## Interface

- [[fileId]](./[fileId]/README.md) — Handlers and helpers at `/files/[fileId]`. Authenticated upload and purpose-scoped evidence viewing routes.
- [upload](./upload/README.md) — Handlers and helpers at `/files/upload`. Authenticated upload and purpose-scoped evidence viewing routes.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
