# upload

## Overview

Handlers and helpers at `/files/upload`. Authenticated upload and purpose-scoped evidence viewing routes.

Parent blueprint: [up one directory](../README.md).

## Interface

- HTTP POST `/files/upload`.
- [route.ts](./route.ts) — `POST`.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `uploadFile`; persistence or external operations belong to those called services.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 6,551 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
