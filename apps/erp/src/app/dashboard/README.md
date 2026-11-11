# dashboard

## Overview

Handlers and helpers at `/dashboard`. Pure inclusive business-date range helpers used by the ERP dashboard.

Parent blueprint: [up one directory](../README.md).

## Interface

- [lib.ts](./lib.ts) — `previousRange`, `RangePreset`, `RANGE_PRESETS`, `presetRange`, `eachDay`, `dayCount`, `resolveRange`, `shortDay`, `fmtNum`.

## Invariants

- Preserve the declared input/output types; domain rules and authorization remain with the callers and shared packages.

## Side Effects

- Invokes `addDays`; persistence or external operations belong to those called services.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 3,991 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
