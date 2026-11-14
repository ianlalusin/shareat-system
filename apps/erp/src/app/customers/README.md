# customers

## Overview

Customers at `/customers`. Customer credit, receivables, collections and wholesale price lists.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/customers`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `CustomerListRow`, `arStoresFor`, `listRegister`, `listLists`, `PriceListDetail`, `getListDetail`, `CustomerDetail`, `getCustomer`, `getPosition`, `isOverLimit`, `creditBalance`, `listCharges`, `listCollections`, `openItemsFor`, `storesWithOpenItems`, `moneyAccountsFor`, `otherOrgs`, `today`, `TREATMENT_LABEL`, `TREATMENT_TONE`, `GROUP_LABEL`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `createCustomerAction`, `reconcileCustomerAction`, `AutoAllocateCollectionRequest`, `AutoAllocateCollectionResponse`, `autoAllocateCollectionAction`, `recordCollectionAction`, `voidCollectionAction`, `voidChargeAction`, `writeOffChargeAction`.
- [page.tsx](./page.tsx) — `CustomersPage`.
- [[customerId]](./[customerId]/README.md) — Customer at `/customers/[customerId]`. Customer credit, receivables, collections and wholesale price lists.
- [price-lists](./price-lists/README.md) — Price lists at `/customers/price-lists`. Customer credit, receivables, collections and wholesale price lists.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `reconcileCustomerAction`, `createCustomerAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createCustomer`, `recordCollection`, `claimUpload`, `voidCharge`, `voidCollection`, `recordApproval`, `createCustomerAction`; persistence or external operations belong to those called services.
- Repository calls: `customersRepo.listCustomersInScope`, `customersRepo.balancesByCustomer`, `customersRepo.listPriceLists`, `customersRepo.getPriceList`, `customersRepo.listPriceListItems`, `customersRepo.getByIdInScope`, `arRepo.positionOf`, `arRepo.creditBalanceOf`, `arRepo.listChargesForCustomer`, `arRepo.listCollectionsForCustomer`, `arRepo.openItems`, `moneyAccountsRepo.listMoneyAccounts`, `moneyAccountsRepo.balanceOf`, `customersRepo.otherOrgs`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 38,129 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
