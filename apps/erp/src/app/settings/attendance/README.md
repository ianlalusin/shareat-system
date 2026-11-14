# attendance

## Overview

Attendance & payroll settings at `/settings/attendance`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/settings/attendance`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `liveConfigFor`, `leaveSettingsFor`, `withOrgPrincipal`, `listStores`.
- [actions.ts](./actions.ts) — `updateAttendanceConfigAction`, `saveLeaveCapAction`, `addLeaveTypeAction`, `setLeaveTypeActiveAction`.
- [page.tsx](./page.tsx) — `AttendanceSettingsPage`.
- [typed-forms.ts](./typed-forms.ts) — `ATTENDANCE_POLICY`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `updateAttendanceConfigAction`, `saveLeaveCapAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `addLeaveType`, `setLeaveCap`, `setLeaveTypeActive`, `supersedeConfig`, `addShiftDays`, `addLeaveTypeAction`, `saveLeaveCapAction`, `setLeaveTypeActiveAction`, `updateAttendanceConfigAction`; persistence or external operations belong to those called services.
- Repository calls: `attendanceConfigRepo.findLive`, `employmentRepo.listPositions`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 24,855 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
