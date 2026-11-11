# reports

## Overview

Handlers and helpers at `/reports`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.

Parent blueprint: [up one directory](../README.md).

## Interface

- [lib.ts](./lib.ts) — `StoreOption`, `ReportScope`, `reportScope`, `scopedStores`, `runReport`, `mayReadCustomerBalances`, `withOrgPrincipal`.
- [ap-aging](./ap-aging/README.md) — AP Aging at `/reports/ap-aging`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [ar-aging](./ar-aging/README.md) — AR Aging at `/reports/ar-aging`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [balance-sheet](./balance-sheet/README.md) — Balance Sheet at `/reports/balance-sheet`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [cash-flow](./cash-flow/README.md) — Cash Flow at `/reports/cash-flow`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [dual-run](./dual-run/README.md) — Dual run at `/reports/dual-run`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [income-statement](./income-statement/README.md) — Income Statement at `/reports/income-statement`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [journal-lines](./journal-lines/README.md) — Journal Lines at `/reports/journal-lines`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [pos-reconciliation](./pos-reconciliation/README.md) — POS Reconciliation at `/reports/pos-reconciliation`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [sales-rollup](./sales-rollup/README.md) — Sales Rollup at `/reports/sales-rollup`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [store-comparison](./store-comparison/README.md) — Store Comparison at `/reports/store-comparison`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [trial-balance](./trial-balance/README.md) — Trial Balance at `/reports/trial-balance`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- `reportScope` resolves the signed-in organization, report capability and allowed store scope before reading report data.

## Side Effects

- Repository calls: `accessRepo.personCoversWholeOrg`, `accessRepo.storeIdsForPerson`. These execute through the surrounding transaction context.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 7,908 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
