# [id]

## Overview

Sales day at `/sales-days/[id]`. Manual or imported sales days, submission, verification and POS correction workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/sales-days/[id]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `SalesDayDetailPage`.
- [edit](./edit/README.md) — Edit sales day at `/sales-days/[id]/edit`. Manual or imported sales days, submission, verification and POS correction workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `addDays`; persistence or external operations belong to those called services.
- Repository calls: `salesDaysRepo.getById`, `salesDaysRepo.getChannelsForDay`, `journalRepo.findLinesForEntryWithAccountCodes`, `journalRepo.findReversalOfEntry`, `posV1Repo.getFeedById`, `salesDaysRepo.listChannels`, `posV1Repo.listCorrectionsForDay`, `posV1Repo.feedDrift`. These execute through the surrounding transaction context.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 14,888 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
