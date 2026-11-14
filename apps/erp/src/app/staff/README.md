# staff

## Overview

Staff at `/staff`. Store-scoped staff roster, hiring, employment details and credential enrollment.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/staff`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `staffStoresFor`, `PositionAssignment`, `RosterViewRow`, `rosterForStore`, `positionsForStore`, `EmploymentDetail`, `employmentDetail`, `governmentIdsFor`, `livePinFor`, `otherOpenBranchesFor`, `searchPersonsFor`, `mediaFor`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [PinSignInPanel.tsx](./PinSignInPanel.tsx) — `PinSignInPanelStatus`, `PinSignInPanel`.
- [StaffViews.tsx](./StaffViews.tsx) — `LiveState`, `LiveEntry`, `StaffPerson`, `ViewSwitch`, `CardWall`, `Roster`.
- [actions.ts](./actions.ts) — `hireAction`, `setPositionsAction`, `endEmploymentAction`, `issuePinAction`, `renamePersonAction`, `setGovernmentIdsAction`.
- [page.tsx](./page.tsx) — `StaffPage`.
- [[employmentId]](./[employmentId]/README.md) — Employment at `/staff/[employmentId]`. Store-scoped staff roster, hiring, employment details and credential enrollment.
- [hire](./hire/README.md) — Hire at `/staff/hire`. Store-scoped staff roster, hiring, employment details and credential enrollment.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `reopenPinSignInAction`, `upsertStorePositionAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createEmployment`, `createPerson`, `endEmployment`, `setEmploymentPositions`, `setGovernmentIds`, `setPin`, `recordApproval`; persistence or external operations belong to those called services.
- Repository calls: `employmentRepo.listActiveRoster`, `employmentRepo.listEmploymentPositionsFor`, `employmentRepo.listPositions`, `employmentRepo.getEmployment`, `personsRepo.getPersonById`, `personsRepo.getNameParts`, `employmentRepo.listEmploymentPositions`, `accessRepo.activeRoleForPerson`, `statutoryRepo.governmentIdsFor`, `employmentRepo.personHasEmploymentAtStores`, `sessionsRepo.listLiveForPerson`, `employmentRepo.listOtherOpenBranches`, `accessRepo.personIsActiveAdmin`, `employmentRepo.photoFileIds`, `pinAttemptsRepo.statusForStore`, `accessRepo.listActiveAdminsWithPinState`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 5 local production/configuration files scanned; 50,000 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
