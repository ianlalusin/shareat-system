# dual-run

## Overview

Dual run at `/reports/dual-run`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/reports/dual-run`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `recordDualRunDispositionAction`.
- [page.tsx](./page.tsx) — `DualRunOverviewPage`.
- [ui.tsx](./ui.tsx) — `VerdictBadge`, `FAMILY_LABEL`, `peso`, `isMonday`, `manilaDateTime`.
- [[store]](./[store]/README.md) — Route namespace `/reports/dual-run/[store]`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [pack](./pack/README.md) — Dual run pack at `/reports/dual-run/pack`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- `reportScope` resolves the signed-in organization, report capability and allowed store scope before reading report data.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `recordDualRunDisposition`; persistence or external operations belong to those called services.
- Repository calls: `dualRunReadsRepo.storesByIds`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 8,187 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
