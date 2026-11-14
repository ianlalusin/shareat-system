# usage-source

## Overview

Usage source at `/menu/usage-source`. Menu catalogue, store prices, item requests and POS depletion-source controls.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/menu/usage-source`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `LinkRow`, `UnlinkedMap`, `SwitchRow`, `VariantChoice`, `UsageSourcePageData`, `loadUsageSourcePage`.
- [actions.ts](./actions.ts) — `linkItemAction`, `seedLinkAction`, `unlinkItemAction`, `switchSourceAction`.
- [page.tsx](./page.tsx) — `UsageSourcePage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `unlinkItemAction`, `seedLinkAction`, `linkItemAction`, `switchSourceAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `linkPosV1Item`, `unlinkPosV1Item`, `linkItemAction`, `unlinkItemAction`; persistence or external operations belong to those called services.
- Repository calls: `menuRepo.usageSourceInForce`, `menuRepo.usageSwitchHistory`, `posMappingRepo.listActiveMaps`, `stockLocationsRepo.listActiveLocations`, `menuRepo.listActiveLinks`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 19,968 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
