# prepaid

## Overview

Prepaid expenses at `/prepaid`. Prepaid cost register, term confirmation, amortisation and write-off.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/prepaid`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `PrepaidListRow`, `listRegister`, `reviewCount`, `PrepaidDetail`, `getDetail`, `CATEGORY_LABEL`, `STATUS_LABEL`, `thisPeriod`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `createPrepaidItemAction`, `amortiseAction`, `confirmTermAction`, `reverseMonthAction`, `writeOffAction`.
- [page.tsx](./page.tsx) — `PrepaidPage`.
- [[id]](./[id]/README.md) — Prepaid item at `/prepaid/[id]`. Prepaid cost register, term confirmation, amortisation and write-off.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createPrepaidItemAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createPrepaidItem`, `reverseAmortisation`, `recordApproval`, `createPrepaidItemAction`; persistence or external operations belong to those called services.
- Repository calls: `prepaidRepo.listPrepaidItems`, `prepaidRepo.amortisedByItem`, `prepaidRepo.countNeedingReview`, `prepaidRepo.getById`, `prepaidRepo.amortisedFromLedger`, `prepaidRepo.postedPeriods`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 24,270 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
