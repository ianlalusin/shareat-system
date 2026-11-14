# [employmentId]

## Overview

Employment at `/staff/[employmentId]`. Store-scoped staff roster, hiring, employment details and credential enrollment.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/staff/[employmentId]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `EmploymentDetailPage`.
- [credentials](./credentials/README.md) — Credentials at `/staff/[employmentId]/credentials`. Store-scoped staff roster, hiring, employment details and credential enrollment.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `renamePersonAction`, `setPositionsAction`, `issuePinAction`, `setGovernmentIdsAction`, `setStaffPhotoAction`, `removeStaffPhotoAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `employmentDetail`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 15,902 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
