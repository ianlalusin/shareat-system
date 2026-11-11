# money-transfers

## Overview

Money transfers at `/money-transfers`. Movement between money accounts and settlement between stores.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/money-transfers`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `AccountOption`, `listAccountBalances`, `listTransferableAccounts`, `SettlementPair`, `listSettlementPairs`, `listRecentTransfers`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`, `CUSTODIAN_LABEL`, `INSTRUMENT_LABEL`.
- [RecordTransferForm.tsx](./RecordTransferForm.tsx) — `RecordTransferForm`.
- [SettleBetweenStoresForm.tsx](./SettleBetweenStoresForm.tsx) — `SettlePairOption`, `SettleBetweenStoresForm`.
- [actions.ts](./actions.ts) — `createMoneyTransferAction`, `settleBetweenStoresAction`, `voidMoneyTransferAction`.
- [page.tsx](./page.tsx) — `MoneyTransfersPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `createMoneyTransferAction`, `settleBetweenStoresAction`, `voidMoneyTransferAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createMoneyTransferAction`, `settleBetweenStoresAction`, `createMoneyTransfer`, `settleBetweenStores`, `voidMoneyTransfer`, `recordApproval`, `voidMoneyTransferAction`; persistence or external operations belong to those called services.
- Repository calls: `moneyAccountsRepo.listMoneyAccounts`, `moneyAccountsRepo.balanceOf`, `moneyTransfersRepo.interStorePositions`, `moneyTransfersRepo.listMoneyTransfers`, `moneyAccountsRepo.getById`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 5 local production/configuration files scanned; 37,952 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
