# api

## Overview

Route namespace `/api`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.

Parent blueprint: [up one directory](../README.md).

## Interface

- [dev](./dev/README.md) — Route namespace `/api/dev`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.
- [health](./health/README.md) — Handlers and helpers at `/api/health`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
