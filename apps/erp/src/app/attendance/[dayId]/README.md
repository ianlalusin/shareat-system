# [dayId]

## Overview

Attendance day at `/attendance/[dayId]`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/attendance/[dayId]`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `approveOvertimeAction`, `setStartAnchorAction`, `approveEarlyOutAction`, `overrideHalfDayAction`, `verifyDayAction`, `voidDayAction`.
- [page.tsx](./page.tsx) — `AttendanceDayPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `approveOvertimeAction`, `setStartAnchorAction`, `approveEarlyOutAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `recordAdjustment`, `recordApproval`, `approveEarlyOutAction`, `approveOvertimeAction`, `setStartAnchorAction`, `voidDayAction`; persistence or external operations belong to those called services.
- Loads screen/report data through `loadDestructiveTarget`, `loadDay`.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 20,410 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
