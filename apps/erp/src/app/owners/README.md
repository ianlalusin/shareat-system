# owners

## Overview

Owners at `/owners`. Owner contributions, drawings, receivable settlement and monthly close.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/owners`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `OwnerListRow`, `listRegister`, `OwnerDetail`, `getDetail`, `moneyAccounts`, `today`, `previousMonth`, `TREATMENT_LABEL`, `AGED_DAYS`, `peso`, `listStores`, `listActivePersons`, `withOrgPrincipal`, `StoreOption`, `monthOf`.
- [actions.ts](./actions.ts) — `createOwnerAction`, `contributionAction`, `drawingAction`, `settleAction`, `closeMonthAction`.
- [page.tsx](./page.tsx) — `OwnersPage`.
- [[id]](./[id]/README.md) — Owner at `/owners/[id]`. Owner contributions, drawings, receivable settlement and monthly close.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createOwnerAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `closeDrawingMonth`, `createOwner`, `recordContribution`, `recordDrawing`, `recordApproval`, `createOwnerAction`; persistence or external operations belong to those called services.
- Repository calls: `ownersRepo.listOwners`, `ownersRepo.positionsByOwner`, `ownersRepo.agedReceivables`, `ownersRepo.getById`, `ownersRepo.positionOf`, `ownersRepo.listCloses`, `ownersRepo.drawnInWindow`, `moneyAccountsRepo.listMoneyAccounts`, `moneyAccountsRepo.balanceOf`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 23,043 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
