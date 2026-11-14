# money-lines

## Overview

Server preparation of wallet and open-float payloads for the shared money-lines control.

Parent blueprint: [up one directory](../README.md).

## Interface

- [load.ts](./load.ts) — `MoneyLinesData`, `openFloatsForStore`, `payableFloatsForStore`, `hasUnroutedFloatsForStore`, `loadMoneyLines`.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.

## Side Effects

- Repository calls: `cashRequestsRepo.openFloats`, `cashRequestsRepo.floatsByRequest`, `moneyAccountsRepo.listMoneyAccounts`, `moneyAccountsRepo.balancesFor`. These execute through the surrounding transaction context.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 9,642 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
