# money

## Overview

Money-line controls and issue visibility driven by shared domain money-line rules.

Parent blueprint: [up one directory](../README.md).

## Interface

- [MoneyLines.tsx](./MoneyLines.tsx) — `MoneyLinesProps`, `MoneyLines`.
- [money-line-visibility.ts](./money-line-visibility.ts) — `LineField`, `visibleIssues`.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.
- Money-line visibility and validation come from shared domain money-line rules; the server rechecks submitted lines.

## Side Effects

- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 17,854 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
