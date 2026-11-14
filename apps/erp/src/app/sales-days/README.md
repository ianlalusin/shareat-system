# sales-days

## Overview

Sales days at `/sales-days`. Manual or imported sales days, submission, verification and POS correction workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/sales-days`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `ChannelOption`, `listChannels`, `StoreWallet`, `listStoreMoneyAccounts`, `getStoreLink`, `listStores`, `listActingPersons`, `withOrgPrincipal`, `StoreOption`, `PersonOption`.
- [SalesDayForm.tsx](./SalesDayForm.tsx) — `SalesDayDefaults`, `SalesDayFormProps`, `SalesDayForm`.
- [actions.ts](./actions.ts) — `createSalesDayAction`, `importSalesDayAction`, `recheckPosDayAction`, `postPosCorrectionAction`, `reimportSalesDayAction`, `editSalesDayAction`, `submitSalesDayAction`, `verifySalesDayAction`, `voidSalesDayAction`, `setPlatformSalesAction`.
- [page.tsx](./page.tsx) — `SalesDaysPage`.
- [typed-forms.ts](./typed-forms.ts) — `PLATFORM_SALES_EDIT`.
- [[id]](./[id]/README.md) — Sales day at `/sales-days/[id]`. Manual or imported sales days, submission, verification and POS correction workflows.
- [new](./new/README.md) — New sales day at `/sales-days/new`. Manual or imported sales days, submission, verification and POS correction workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `createSalesDay`, `postPosCorrection`, `setPlatformSales`, `submitSalesDay`, `voidSalesDay`, `recordApproval`; persistence or external operations belong to those called services.
- Repository calls: `salesDaysRepo.listChannels`, `moneyAccountsRepo.listMoneyAccounts`, `posV1Repo.getLinkByStore`, `salesDaysRepo.listSalesDays`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 5 local production/configuration files scanned; 39,107 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
