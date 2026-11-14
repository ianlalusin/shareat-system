# findings

## Overview

Findings at `/findings`. Derived integrity observations, acknowledgements, close controls and response scorecards.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/findings`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `selectablePeriods`, `findingsFor`, `bySeverityThenStatus`, `KIND_LABEL`, `noteFindingView`, `scorecardRange`, `scorecardFor`, `peso`, `withOrgPrincipal`, `lastCompletedPeriod`.
- [actions.ts](./actions.ts) — `acknowledgeFindingAction`, `closePeriodAction`, `createMissingClosedPeriodAction`, `bookMissedMonthAction`.
- [page.tsx](./page.tsx) — `FindingsPage`.
- [scorecard](./scorecard/README.md) — Responsiveness scorecard at `/findings/scorecard`. Derived integrity observations, acknowledgements, close controls and response scorecards.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `closePeriodAction`, `acknowledgeFindingAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `closeReadiness`, `acknowledgeFinding`, `closePeriod`, `createMissingClosedPeriod`, `acknowledgeFindingAction`, `closePeriodAction`, `createMissingClosedPeriodAction`; persistence or external operations belong to those called services.
- Repository calls: `storesRepo.listForOrg`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 23,716 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
