# statutory-discounts

## Overview

SC/PWD register at `/statutory-discounts`. SC/PWD discount recording and voiding register.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/statutory-discounts`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `recordStatutoryDiscountAction`, `voidStatutoryDiscountAction`.
- [page.tsx](./page.tsx) — `StatutoryDiscountsPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `voidStatutoryDiscountAction`, `recordStatutoryDiscountAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `recordStatutoryDiscount`, `voidStatutoryDiscount`, `recordApproval`, `recordStatutoryDiscountAction`, `voidStatutoryDiscountAction`; persistence or external operations belong to those called services.
- Loads screen/report data through `loadDestructiveTarget`, `listStatutoryDiscounts`, `listStores`.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 22,799 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
