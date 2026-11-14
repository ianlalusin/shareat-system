# unpaid

## Overview

Everything unpaid at `/liabilities/unpaid`. Liability charges, payments and ledger-derived unpaid obligations.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/liabilities/unpaid`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `orderLines`, `isOverdue`, `leftoverDirection`, `daysWord`.
- [page.tsx](./page.tsx) — `UnpaidPage`.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- `reportScope` resolves the signed-in organization, report capability and allowed store scope before reading report data.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Loads screen/report data through `getUnpaidLiabilities`, `reportScope`, `runReport`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 11,766 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
