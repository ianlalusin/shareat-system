# [id]

## Overview

Order wastage at `/wastage/[id]`. Order/channel wastage recording, dispute, settlement matching and charge reversal.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/wastage/[id]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `WastageDetailPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `confirmSettlementMatchAction`, `resolveOrderWastageAction`, `disputeOrderWastageAction`, `reverseAutoChargeAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Repository calls: `orderWastageRepo.findById`, `orderWastageRepo.listAllocations`. These execute through the surrounding transaction context.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 9,493 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
