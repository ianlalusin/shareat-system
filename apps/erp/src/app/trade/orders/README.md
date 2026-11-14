# orders

## Overview

Trade orders at `/trade/orders`. Wholesale order fulfilment, delivery receipt printing and customer returns.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/trade/orders`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `STATUS_LABEL`, `today`, `CustomerOption`, `ItemOption`, `OrderFormData`, `orderFormData`, `tradeStoresFor`, `canSeeCreditLimit`, `orderRegister`, `OrderLineView`, `OrderDetail`, `orderDetail`, `storeMoneyAccounts`, `creditPreview`, `DeliveryReceiptData`, `deliveryReceiptData`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [NewOrderForm.tsx](./NewOrderForm.tsx) — `NewOrderForm`.
- [actions.ts](./actions.ts) — `createOrderAction`, `dispatchOrderAction`, `setBirInvoiceNoAction`, `receiveOrderAction`, `voidOrderAction`.
- [page.tsx](./page.tsx) — `TradeOrdersPage`.
- [typed-forms.ts](./typed-forms.ts) — `BIR_INVOICE_NO`.
- [[id]](./[id]/README.md) — Trade order at `/trade/orders/[id]`. Wholesale order fulfilment, delivery receipt printing and customer returns.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `createOrderAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `claimUpload`, `createTradeOrder`, `dispatchTradeOrder`, `receiveTradeOrder`, `setBirInvoiceNo`, `voidTradeOrder`, `recordApproval`, `createOrderAction`; persistence or external operations belong to those called services.
- Repository calls: `customersRepo.listCustomers`, `itemsRepo.listItems`, `customersRepo.listPriceLists`, `itemsRepo.listItemPricing`, `customersRepo.listPriceListItems`, `tradeRepo.listOrders`, `tradeRepo.getOrderById`, `customersRepo.getById`, `tradeRepo.linesFor`, `itemsRepo.getItemById`, `moneyAccountsRepo.listMoneyAccounts`, `arRepo.paidForCharge`, `arRepo.outstandingForCharge`, `arRepo.positionOf`, `arRepo.creditBalanceOf`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 5 local production/configuration files scanned; 39,969 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
