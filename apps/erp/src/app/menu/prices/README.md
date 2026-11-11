# prices

## Overview

Menu prices at `/menu/prices`. Menu catalogue, store prices, item requests and POS depletion-source controls.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/menu/prices`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `setPriceAction`, `withdrawPriceAction`, `cancelScheduledPriceAction`, `setOptionPriceAction`, `cancelScheduledOptionPriceAction`.
- [page.tsx](./page.tsx) — `MenuPricesPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `cancelScheduledPriceAction`, `setPriceAction`, `withdrawPriceAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `cancelScheduledOffer`, `cancelScheduledOptionOffer`, `setMenuOffer`, `setOptionOffer`, `withdrawMenuOffer`, `cancelScheduledOptionPriceAction`, `cancelScheduledPriceAction`, `setOptionPriceAction`, `setPriceAction`, `withdrawPriceAction`; persistence or external operations belong to those called services.
- Loads screen/report data through `loadPricesPage`.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 21,007 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
