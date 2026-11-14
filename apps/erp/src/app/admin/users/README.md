# users

## Overview

Users and roles at `/admin/users`. Organization, store, user and position-default administration.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/admin/users`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `PositionDefaultSource`, `GrantWithSource`, `listUsers`, `UserDetail`, `SignInCredential`, `userDetail`, `grantableCapabilitiesFor`, `grantSourceLabel`, `positionProvenanceLine`, `canRevokeHere`, `grantSummaryLine`, `FoldedGrant`, `foldActiveGrants`, `requireRevokeReason`, `listStores`, `withOrgPrincipal`, `StoreOption`, `PersonWithAccessRow`.
- [actions.ts](./actions.ts) — `assignRoleAction`, `setStoreScopeAction`, `setCapabilityGrantAction`, `linkFirebaseAction`, `unlinkCredentialAction`.
- [page.tsx](./page.tsx) — `UsersPage`.
- [[personId]](./[personId]/README.md) — User access at `/admin/users/[personId]`. Organization, store, user and position-default administration.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `assignRoleAsActor`, `linkFirebaseCredential`; persistence or external operations belong to those called services.
- Repository calls: `personsRepo.listWithAccessForOrg`, `accessRepo.storeIdsForPerson`, `accessRepo.grantsForPerson`, `sessionsRepo.listLiveForPerson`, `positionDefaultsRepo.describeSources`, `accessRepo.storeBelongsToOrg`, `accessRepo.grantStoreScope`, `destructiveTargetsRepo.targetOf`, `accessRepo.revokeStoreScope`, `accessRepo.revokeGrantById`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 34,439 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
