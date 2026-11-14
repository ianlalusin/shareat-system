# health

## Overview

Handlers and helpers at `/api/health`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.

Parent blueprint: [up one directory](../README.md).

## Interface

- HTTP GET `/api/health`.
- [route.ts](./route.ts) — `GET`.

## Invariants

- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Unauthenticated health responses separate invalid configuration from database unreachability; error detail is omitted in production and revision is returned on both success and failure.

## Side Effects

- Validates environment, runs `select 1` against PostgreSQL, logs failures, and returns HTTP 200 or 503.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 3,378 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
