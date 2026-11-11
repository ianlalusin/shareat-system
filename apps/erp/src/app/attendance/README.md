# attendance

## Overview

Attendance review at `/attendance`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/attendance`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `loadQueue`, `loadRoster`, `loadLeaveGrid`, `loadDay`, `defaultRange`, `asClock`, `asHours`, `listStores`, `withOrgPrincipal`, `StoreOption`, `REVIEW_REASON_TEXT`, `DayReviewDetail`, `QueuedDay`, `ReviewDayRow`.
- [page.tsx](./page.tsx) — `AttendanceReviewPage`.
- [[dayId]](./[dayId]/README.md) — Attendance day at `/attendance/[dayId]`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.
- [lane](./lane/README.md) — The clock lane at `/attendance/lane`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.
- [leave](./leave/README.md) — Leave at `/attendance/leave`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.
- [terminals](./terminals/README.md) — Clock terminals at `/attendance/terminals`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Repository calls: `attendanceConfigRepo.findLive`. These execute through the surrounding transaction context.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 14,186 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
