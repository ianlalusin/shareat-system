# scorecard

## Overview

Responsiveness scorecard at `/findings/scorecard`. Derived integrity observations, acknowledgements, close controls and response scorecards.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/findings/scorecard`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `ScorecardPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; rendering/pure transformation is the local boundary, with submitted callbacks owned by callers.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 8,693 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
