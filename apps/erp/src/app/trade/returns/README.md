# returns

## Overview

Customer returns at `/trade/returns`. Wholesale order fulfilment, delivery receipt printing and customer returns.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/trade/returns`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `recordReturnAction`, `voidReturnAction`, `applyCreditAction`.
- [page.tsx](./page.tsx) — `CustomerReturnsPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `recordReturnAction`, `voidReturnAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `recordCustomerReturn`, `voidCustomerReturn`, `recordApproval`, `recordReturnAction`, `voidReturnAction`; persistence or external operations belong to those called services.
- Loads screen/report data through `loadDestructiveTarget`, `listStores`.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 18,830 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
