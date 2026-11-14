# leave

## Overview

Leave at `/attendance/leave`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/attendance/leave`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `loadMine`, `holdsManageAttendance`, `loadStoreLeave`, `loadRoster`, `loadRequestDetail`, `loadProofFileId`, `loadBalanceOf`, `RequestGroup`, `groupByRequest`, `expandRange`, `labelFor`, `withOrgPrincipal`, `listStores`, `LeaveRequestView`, `LeaveRow`, `MyLeave`.
- [CertificateView.tsx](./CertificateView.tsx) — `CertificateView`.
- [actions.ts](./actions.ts) — `requestLeaveAction`, `recordLeaveAction`, `approveLeaveAction`, `rejectLeaveAction`, `cancelLeaveAction`, `voidLeaveAction`, `attachLeaveDocumentAction`.
- [page.tsx](./page.tsx) — `LeavePage`.
- [export](./export/README.md) — Handlers and helpers at `/attendance/leave/export`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `requestLeaveAction`, `cancelLeaveAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `approveLeave`, `cancelLeave`, `recordLeave`, `rejectLeave`, `voidLeave`, `approveLeaveAction`, `cancelLeaveAction`, `recordLeaveAction`, `rejectLeaveAction`, `voidLeaveAction`; persistence or external operations belong to those called services.
- Repository calls: `employmentRepo.listActiveRoster`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 26,879 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
