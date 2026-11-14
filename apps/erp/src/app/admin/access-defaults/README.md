# access-defaults

## Overview

Position access defaults at `/admin/access-defaults`. Organization, store, user and position-default administration.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/admin/access-defaults`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `SCOPE_ORDER`, `SCOPE_NOTE`, `GridCapability`, `GridAreaGroup`, `GridScopeGroup`, `gridCapabilityGroups`, `areaOnCount`, `parseOpenParams`, `overlapDisclosure`, `bannerMessage`, `bulkBannerMessage`, `copyableDefaults`, `storesForActor`, `GridPosition`, `ActiveDefaultsByPosition`, `EmploymentPositionLink`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `toggleDefaultAction`, `sameForEveryStoreAction`, `copyDefaultsAction`, `retireStorePositionAction`.
- [grid.tsx](./grid.tsx) — `DesktopGrid`, `MobileSections`.
- [page.tsx](./page.tsx) — `AccessDefaultsPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `toggleDefaultAction`, `retireStorePositionAction`, `sameForEveryStoreAction`, `copyDefaultsAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `retireStorePosition`, `setPositionDefault`, `retireStorePositionAction`; persistence or external operations belong to those called services.
- Repository calls: `accessRepo.storeIdsForPerson`, `accessRepo.activeStoreIdsForOrg`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 48,967 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
