# [route]

## Overview

Handlers and helpers at `/api/dev/fake-pos/api/external/[route]`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.

Parent blueprint: [up one directory](../README.md).

## Interface

- HTTP GET `/api/dev/fake-pos/api/external/[route]`.
- [route.ts](./route.ts) — `GET`.

## Invariants

- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Disabled in production; requires `POS_FAKE_ENABLED=1` and matching `x-api-key`. Route/store/date validation precedes fixture-path construction.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; rendering/pure transformation is the local boundary, with submitted callbacks owned by callers.
- Reads JSON fixture bytes from `dev-fixtures/pos-v1` and serves stores, payment-methods, sales or sold-items; no POS production writes.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 3,558 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
