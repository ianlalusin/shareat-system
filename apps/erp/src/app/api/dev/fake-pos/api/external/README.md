# external

## Overview

Development-only POS bridge namespace `/api/dev/fake-pos/api/external`. Its external route serves validated fixture-backed stores, payment methods, sales and sold-items responses.

Parent blueprint: [up one directory](../README.md).

## Interface

- [[route]](./[route]/README.md) — Handlers and helpers at `/api/dev/fake-pos/api/external/[route]`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
