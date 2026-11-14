# balance-sheet

## Overview

Balance Sheet at `/reports/balance-sheet`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/reports/balance-sheet`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `BalanceSheetPage`.
- [export](./export/README.md) — Handlers and helpers at `/reports/balance-sheet/export`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- `reportScope` resolves the signed-in organization, report capability and allowed store scope before reading report data.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Loads screen/report data through `getBalanceSheet`, `reportScope`, `runReport`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 4,579 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
