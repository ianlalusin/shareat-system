# till

## Overview

Till custody at `/till`. Till shifts, observed counts, close and staff-shortage charging.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/till`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `ShiftView`, `nextMomentFor`, `tillOverview`, `today`, `varianceOf`, `chargeableShortages`, `varianceSentence`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`, `TillCountRow`, `TillShiftRow`.
- [actions.ts](./actions.ts) — `openShiftAction`, `recordCountAction`, `closeShiftAction`, `chargeShortageAction`.
- [page.tsx](./page.tsx) — `TillPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `openShiftAction`, `recordCountAction`, `closeShiftAction`, `chargeShortageAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `chargeTillShortage`, `closeTillShift`, `openTillShift`, `recordTillCount`, `chargeShortageAction`, `closeShiftAction`, `openShiftAction`, `recordCountAction`, `chargeableShortages`; persistence or external operations belong to those called services.
- Repository calls: `tillShiftsRepo.countableAccounts`, `tillShiftsRepo.listShifts`, `tillShiftsRepo.countsFor`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 22,996 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
