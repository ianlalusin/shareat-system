# requests

## Overview

Item requests at `/menu/requests`. Menu catalogue, store prices, item requests and POS depletion-source controls.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/menu/requests`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `submitItemRequestAction`, `withdrawItemRequestAction`, `approveItemRequestAction`, `markItemRequestDuplicateAction`, `rejectItemRequestAction`.
- [page.tsx](./page.tsx) — `MenuRequestsPage`.
- [typed-forms.ts](./typed-forms.ts) — `ITEM_REQUEST`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `approveItemRequestAction`, `markItemRequestDuplicateAction`, `rejectItemRequestAction`, `submitItemRequestAction`, `withdrawItemRequestAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `approveMenuItemRequest`, `rejectMenuItemRequest`, `withdrawMenuItemRequest`, `approveItemRequestAction`, `rejectItemRequestAction`, `submitItemRequestAction`, `withdrawItemRequestAction`, `openRequests`; persistence or external operations belong to those called services.
- Repository calls: `menuRepo.similarMenuItems`, `menuRepo.similarOpenRequests`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 17,520 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
